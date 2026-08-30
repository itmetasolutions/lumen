import 'server-only'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { env } from '@/server/env'
import { getS3Connection } from '@/server/settings/connections'

/**
 * Storage adapter for screenshots and generated exports (§17, §29).
 *
 * Files are never served from a public URL. `put` returns an opaque key; the
 * route handler that serves it checks workspace membership first.
 */

export interface StoredObject {
  key: string
  bytes: number
  contentType: string
}

export interface StorageProvider {
  readonly id: string
  put(key: string, data: Buffer, contentType: string): Promise<StoredObject>
  get(key: string): Promise<Buffer>
  delete(key: string): Promise<void>
  exists(key: string): Promise<boolean>
}

/**
 * Local disk. The default, because requiring S3 to take a screenshot would make
 * the product undeployable on a laptop.
 */
class LocalDiskStorage implements StorageProvider {
  readonly id = 'local-disk'

  private root(): string {
    return path.resolve(process.cwd(), env.storageDir)
  }

  /**
   * Keys come from audit ids and filenames we generate, but this is the boundary
   * where a traversal attempt would land, so it is enforced rather than assumed.
   */
  private resolve(key: string): string {
    const safe = key
      .split('/')
      .filter((seg) => seg && seg !== '.' && seg !== '..')
      .map((seg) => seg.replace(/[^a-zA-Z0-9._-]/g, '_'))
      .join('/')
    const full = path.resolve(this.root(), safe)
    if (!full.startsWith(this.root())) {
      throw new Error('Refusing to write outside the storage root')
    }
    return full
  }

  async put(key: string, data: Buffer, contentType: string): Promise<StoredObject> {
    const full = this.resolve(key)
    await fs.mkdir(path.dirname(full), { recursive: true })
    await fs.writeFile(full, data)
    return { key, bytes: data.byteLength, contentType }
  }

  async get(key: string): Promise<Buffer> {
    return fs.readFile(this.resolve(key))
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.resolve(key), { force: true })
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(this.resolve(key))
      return true
    } catch {
      return false
    }
  }
}

/**
 * S3-compatible storage using AWS SigV4 over plain fetch — no SDK dependency.
 * Used when every S3_* variable is present.
 */
class S3Storage implements StorageProvider {
  readonly id = 's3'

  constructor(
    private readonly endpoint: string,
    private readonly accessKey: string,
    private readonly secretKey: string,
    private readonly bucket: string,
    private readonly region = 'us-east-1',
  ) {}

  private url(key: string): string {
    return `${this.endpoint.replace(/\/+$/, '')}/${this.bucket}/${key}`
  }

  async put(key: string, data: Buffer, contentType: string): Promise<StoredObject> {
    const res = await this.signedRequest('PUT', key, data, contentType)
    if (!res.ok) {
      throw new Error(`S3 PUT failed: ${res.status} ${await res.text()}`)
    }
    return { key, bytes: data.byteLength, contentType }
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.signedRequest('GET', key)
    if (!res.ok) throw new Error(`S3 GET failed: ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  }

  async delete(key: string): Promise<void> {
    await this.signedRequest('DELETE', key)
  }

  async exists(key: string): Promise<boolean> {
    const res = await this.signedRequest('HEAD', key)
    return res.ok
  }

  private async signedRequest(
    method: string,
    key: string,
    body?: Buffer,
    contentType?: string,
  ): Promise<Response> {
    const url = new URL(this.url(key))
    const now = new Date()
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
    const dateStamp = amzDate.slice(0, 8)
    const payloadHash = createHash('sha256')
      .update(body ?? Buffer.alloc(0))
      .digest('hex')

    const headers: Record<string, string> = {
      host: url.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    }
    if (contentType) headers['content-type'] = contentType

    const signedHeaders = Object.keys(headers).sort().join(';')
    const canonicalHeaders = Object.keys(headers)
      .sort()
      .map((h) => `${h}:${headers[h]}\n`)
      .join('')

    const canonicalRequest = [
      method,
      url.pathname,
      '',
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n')

    const scope = `${dateStamp}/${this.region}/s3/aws4_request`
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n')

    const { createHmac } = await import('node:crypto')
    const hmac = (k: Buffer | string, d: string) =>
      createHmac('sha256', k).update(d).digest()

    const kDate = hmac(`AWS4${this.secretKey}`, dateStamp)
    const kRegion = hmac(kDate, this.region)
    const kService = hmac(kRegion, 's3')
    const kSigning = hmac(kService, 'aws4_request')
    const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex')

    headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

    return fetch(url.toString(), {
      method,
      headers,
      body: body ? new Uint8Array(body) : undefined,
    })
  }
}

class FallbackStorage implements StorageProvider {
  readonly id = 's3'

  constructor(
    private readonly primary: StorageProvider,
    private readonly fallback: StorageProvider,
  ) {}

  async put(key: string, data: Buffer, contentType: string): Promise<StoredObject> {
    return this.primary.put(key, data, contentType)
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await this.primary.get(key)
    } catch {
      return this.fallback.get(key)
    }
  }

  async delete(key: string): Promise<void> {
    await Promise.allSettled([this.primary.delete(key), this.fallback.delete(key)])
  }

  async exists(key: string): Promise<boolean> {
    return (await this.primary.exists(key)) || this.fallback.exists(key)
  }
}

export async function getStorage(workspaceId?: string): Promise<StorageProvider> {
  const local = new LocalDiskStorage()
  const s3 = await getS3Connection(workspaceId)
  if (s3) {
    return new FallbackStorage(
      new S3Storage(s3.endpoint, s3.accessKey, s3.secretKey, s3.bucket, s3.region),
      local,
    )
  }
  return local
}

export async function storageStatus(workspaceId?: string): Promise<{ id: string; detail: string }> {
  const s = await getStorage(workspaceId)
  return {
    id: s.id,
    detail:
      s.id === 's3'
        ? 'Writing screenshots to S3-compatible object storage.'
        : `Writing to local disk at ${path.resolve(process.cwd(), env.storageDir)}. Add S3 credentials in Settings > Connections to use object storage.`,
  }
}
