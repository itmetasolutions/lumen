import 'server-only'
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto'
import { prisma, type Prisma } from '@/server/db/client'
import { env } from '@/server/env'

export const CONNECTION_PROVIDER_IDS = [
  'google-places',
  'pagespeed',
  'search',
  'yelp-fusion',
  'openai',
  's3',
] as const

export type ConnectionProviderId = (typeof CONNECTION_PROVIDER_IDS)[number]
export type ConnectionFieldType = 'text' | 'secret' | 'select'
export type ConnectionValueSource = 'workspace' | 'environment' | 'none'
export type ConnectionSource = ConnectionValueSource | 'mixed' | 'disabled'

export interface ConnectionFieldDefinition {
  key: string
  label: string
  type: ConnectionFieldType
  required?: boolean
  placeholder?: string
  description?: string
  defaultValue?: string
  options?: Array<{ value: string; label: string }>
}

export interface ConnectionDefinition {
  id: ConnectionProviderId
  label: string
  description: string
  category: 'Discovery' | 'Performance' | 'AI' | 'Storage'
  fields: ConnectionFieldDefinition[]
}

export interface ConnectionFieldSummary extends ConnectionFieldDefinition {
  value?: string
  hasValue: boolean
  source: ConnectionValueSource
}

export interface ConnectionSummary {
  id: ConnectionProviderId
  label: string
  description: string
  category: ConnectionDefinition['category']
  enabled: boolean
  hasWorkspaceRecord: boolean
  source: ConnectionSource
  updatedAt: string | null
  fields: ConnectionFieldSummary[]
  decryptionError: string | null
}

export interface ConnectionBundle {
  provider: ConnectionProviderId
  enabled: boolean
  hasWorkspaceRecord: boolean
  source: ConnectionSource
  config: Record<string, string>
  secrets: Record<string, string>
  workspaceConfigKeys: string[]
  workspaceSecretKeys: string[]
  decryptionError: string | null
}

export const CONNECTION_DEFINITIONS: ConnectionDefinition[] = [
  {
    id: 'google-places',
    label: 'Google Places',
    category: 'Discovery',
    description: 'Places API (New) Text Search and Google geocoding.',
    fields: [
      {
        key: 'apiKey',
        label: 'API key',
        type: 'secret',
        required: true,
        placeholder: 'AIza...',
      },
    ],
  },
  {
    id: 'search',
    label: 'SerpApi search',
    category: 'Discovery',
    description: 'Shared SerpApi key for Google Maps, Yelp and Yandex discovery engines.',
    fields: [
      {
        key: 'apiKey',
        label: 'API key',
        type: 'secret',
        required: true,
        placeholder: 'SerpApi API key',
      },
      {
        key: 'kind',
        label: 'Provider kind',
        type: 'select',
        required: true,
        defaultValue: 'serpapi',
        options: [
          { value: 'serpapi', label: 'SerpApi' },
          { value: 'custom', label: 'Custom compatible API' },
        ],
      },
      {
        key: 'monthlyLimit',
        label: 'Monthly search limit',
        type: 'text',
        required: true,
        defaultValue: '250',
        placeholder: '250',
        description: 'Local cap shared by all SerpApi discovery engines. Use 0 only if the SerpApi account limit should be the only cap.',
      },
      {
        key: 'yelpDomain',
        label: 'Yelp domain',
        type: 'text',
        defaultValue: 'yelp.com',
        placeholder: 'yelp.com',
      },
      {
        key: 'yandexDomain',
        label: 'Yandex domain',
        type: 'text',
        defaultValue: 'yandex.com',
        placeholder: 'yandex.com',
      },
      {
        key: 'yandexLang',
        label: 'Yandex language',
        type: 'text',
        defaultValue: 'en',
        placeholder: 'en',
      },
      {
        key: 'yandexLocationId',
        label: 'Yandex location ID',
        type: 'text',
        placeholder: '84',
        description: 'Optional SerpApi lr value for Yandex regional targeting.',
      },
    ],
  },
  {
    id: 'yelp-fusion',
    label: 'Yelp Fusion API',
    category: 'Discovery',
    description:
      "Yelp's official API. Free tier allows 500 calls/day. Returns website URLs and price range, which the SerpApi Yelp engine does not, and does not consume the SerpApi quota.",
    fields: [
      {
        key: 'apiKey',
        label: 'API key',
        type: 'secret',
        required: true,
        placeholder: 'Yelp Fusion API key',
        description: 'Create one at https://www.yelp.com/developers/v3/manage_app',
      },
      {
        key: 'dailyLimit',
        label: 'Daily call limit',
        type: 'text',
        required: true,
        defaultValue: '500',
        placeholder: '500',
        description: "Local cap matching Yelp's free-tier allowance. Set 0 to rely on Yelp's own limit.",
      },
    ],
  },
  {
    id: 'pagespeed',
    label: 'Google PageSpeed Insights',
    category: 'Performance',
    description: 'Performance lab data and CrUX field data for audited websites.',
    fields: [
      {
        key: 'apiKey',
        label: 'API key',
        type: 'secret',
        placeholder: 'Optional API key',
        description: 'Optional, but recommended for production volume.',
      },
    ],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    category: 'AI',
    description: 'Optional AI-assisted UX commentary from audit screenshots.',
    fields: [
      {
        key: 'apiKey',
        label: 'API key',
        type: 'secret',
        required: true,
        placeholder: 'sk-...',
      },
      {
        key: 'model',
        label: 'Vision model',
        type: 'text',
        required: true,
        defaultValue: 'gpt-4o-mini',
        placeholder: 'gpt-4o-mini',
      },
    ],
  },
  {
    id: 's3',
    label: 'S3-compatible storage',
    category: 'Storage',
    description: 'Optional object storage for audit screenshots.',
    fields: [
      {
        key: 'endpoint',
        label: 'Endpoint',
        type: 'text',
        required: true,
        placeholder: 'https://s3.example.com',
      },
      {
        key: 'bucket',
        label: 'Bucket',
        type: 'text',
        required: true,
        placeholder: 'lumen-audit-assets',
      },
      {
        key: 'region',
        label: 'Region',
        type: 'text',
        required: true,
        defaultValue: 'us-east-1',
        placeholder: 'us-east-1',
      },
      {
        key: 'accessKey',
        label: 'Access key',
        type: 'secret',
        required: true,
        placeholder: 'Access key ID',
      },
      {
        key: 'secretKey',
        label: 'Secret key',
        type: 'secret',
        required: true,
        placeholder: 'Secret access key',
      },
    ],
  },
]

const SECRET_PREFIX = 'enc:v1'
const SECRET_AAD = Buffer.from('lumen-api-credential')

export function isConnectionProviderId(value: string): value is ConnectionProviderId {
  return CONNECTION_PROVIDER_IDS.includes(value as ConnectionProviderId)
}

export function getConnectionDefinition(provider: ConnectionProviderId): ConnectionDefinition {
  return CONNECTION_DEFINITIONS.find((d) => d.id === provider)!
}

export async function getConnectionSummaries(workspaceId: string): Promise<ConnectionSummary[]> {
  return Promise.all(CONNECTION_DEFINITIONS.map((def) => getConnectionSummary(workspaceId, def.id)))
}

export async function getConnectionSummary(
  workspaceId: string,
  provider: ConnectionProviderId,
): Promise<ConnectionSummary> {
  const def = getConnectionDefinition(provider)
  const row = await prisma.apiCredential.findUnique({
    where: { workspaceId_provider: { workspaceId, provider } },
  })
  const bundle = await getConnectionBundle(workspaceId, provider, row)
  const envSecrets = environmentSecrets(provider)
  const envConfig = environmentConfig(provider)
  const rowConfig = jsonRecord(row?.config)

  return {
    id: def.id,
    label: def.label,
    description: def.description,
    category: def.category,
    enabled: bundle.enabled,
    hasWorkspaceRecord: Boolean(row),
    source: bundle.source,
    updatedAt: row?.updatedAt.toISOString() ?? null,
    decryptionError: bundle.decryptionError,
    fields: def.fields.map((field) => {
      if (field.type === 'secret') {
        const workspaceHasValue = bundle.workspaceSecretKeys.includes(field.key)
        const envHasValue = Boolean(envSecrets[field.key])
        return {
          ...field,
          hasValue: workspaceHasValue || envHasValue,
          source: workspaceHasValue ? 'workspace' : envHasValue ? 'environment' : 'none',
        }
      }

      const workspaceValue = rowConfig[field.key]
      const envValue = envConfig[field.key]
      const defaultValue = field.defaultValue
      const value = workspaceValue ?? envValue ?? defaultValue ?? ''
      return {
        ...field,
        value,
        hasValue: Boolean(value),
        source: workspaceValue
          ? 'workspace'
          : envValue
            ? 'environment'
            : 'none',
      }
    }),
  }
}

export async function getConnectionBundle(
  workspaceId: string | undefined,
  provider: ConnectionProviderId,
  existingRow?: Awaited<ReturnType<typeof prisma.apiCredential.findUnique>>,
): Promise<ConnectionBundle> {
  const row =
    existingRow !== undefined
      ? existingRow
      : workspaceId
        ? await prisma.apiCredential.findUnique({
            where: { workspaceId_provider: { workspaceId, provider } },
          })
        : null

  if (row && !row.enabled) {
    return {
      provider,
      enabled: false,
      hasWorkspaceRecord: true,
      source: 'disabled',
      config: {},
      secrets: {},
      workspaceConfigKeys: [],
      workspaceSecretKeys: [],
      decryptionError: null,
    }
  }

  let storedSecrets: Record<string, string> = {}
  let decryptionError: string | null = null
  if (row?.secret) {
    try {
      storedSecrets = decryptSecretMap(row.secret)
    } catch (err) {
      decryptionError = (err as Error).message
    }
  }

  const rowConfig = jsonRecord(row?.config)
  const envSecrets = environmentSecrets(provider)
  const envConfig = environmentConfig(provider)
  const workspaceSecretKeys = Object.keys(storedSecrets).filter((key) => Boolean(storedSecrets[key]))
  const workspaceConfigKeys = Object.keys(rowConfig).filter((key) => Boolean(rowConfig[key]))
  const secrets = { ...envSecrets, ...storedSecrets }
  const config = { ...envConfig, ...rowConfig }
  applyConfigDefaults(provider, config)
  const hasWorkspaceValues = workspaceSecretKeys.length > 0 || workspaceConfigKeys.length > 0
  const hasEnvironmentValues =
    Object.values(envSecrets).some(Boolean) || Object.values(envConfig).some(Boolean)

  return {
    provider,
    enabled: true,
    hasWorkspaceRecord: Boolean(row),
    source: hasWorkspaceValues
      ? hasEnvironmentValues
        ? 'mixed'
        : 'workspace'
      : hasEnvironmentValues
        ? 'environment'
        : 'none',
    config,
    secrets,
    workspaceConfigKeys,
    workspaceSecretKeys,
    decryptionError,
  }
}

export async function getConnectionSecret(
  workspaceId: string | undefined,
  provider: ConnectionProviderId,
  key: string,
): Promise<string | undefined> {
  const bundle = await getConnectionBundle(workspaceId, provider)
  if (bundle.decryptionError) throw new Error(bundle.decryptionError)
  if (!bundle.enabled) return undefined
  const value = bundle.secrets[key]
  return value?.trim() || undefined
}

export async function requireConnectionSecret(
  workspaceId: string,
  provider: ConnectionProviderId,
  key: string,
  label: string,
): Promise<string> {
  const value = await getConnectionSecret(workspaceId, provider, key)
  if (!value) {
    throw new Error(`${label} is not configured. Add it in Settings > Connections.`)
  }
  return value
}

export async function getConnectionConfigValue(
  workspaceId: string | undefined,
  provider: ConnectionProviderId,
  key: string,
): Promise<string | undefined> {
  const bundle = await getConnectionBundle(workspaceId, provider)
  if (!bundle.enabled) return undefined
  const value = bundle.config[key]
  return value?.trim() || undefined
}

export async function saveConnection(input: {
  workspaceId: string
  provider: ConnectionProviderId
  enabled: boolean
  values: Record<string, string>
}): Promise<void> {
  const def = getConnectionDefinition(input.provider)
  const existing = await prisma.apiCredential.findUnique({
    where: {
      workspaceId_provider: {
        workspaceId: input.workspaceId,
        provider: input.provider,
      },
    },
  })

  const config = jsonRecord(existing?.config)
  const secrets = existing?.secret ? decryptSecretMap(existing.secret) : {}

  for (const field of def.fields) {
    if (!(field.key in input.values)) continue

    const value = input.values[field.key]?.trim() ?? ''
    if (field.type === 'secret') {
      if (value) secrets[field.key] = value
      continue
    }

    if (field.type === 'select' && value) {
      const valid = field.options?.some((option) => option.value === value)
      if (!valid) throw new Error(`${field.label} has an unsupported value.`)
    }

    if (value) config[field.key] = value
    else delete config[field.key]
  }

  for (const field of def.fields) {
    if (field.type === 'secret') continue
    if (!field.required || config[field.key]) continue
    if (field.defaultValue) config[field.key] = field.defaultValue
  }

  await prisma.apiCredential.upsert({
    where: {
      workspaceId_provider: {
        workspaceId: input.workspaceId,
        provider: input.provider,
      },
    },
    create: {
      workspaceId: input.workspaceId,
      provider: input.provider,
      label: def.label,
      enabled: input.enabled,
      config: config as Prisma.InputJsonValue,
      secret: encryptSecretMap(secrets),
    },
    update: {
      label: def.label,
      enabled: input.enabled,
      config: config as Prisma.InputJsonValue,
      secret: encryptSecretMap(secrets),
    },
  })
}

export async function deleteConnection(
  workspaceId: string,
  provider: ConnectionProviderId,
): Promise<void> {
  await prisma.apiCredential
    .delete({
      where: {
        workspaceId_provider: { workspaceId, provider },
      },
    })
    .catch(() => {})
}

export async function getS3Connection(workspaceId?: string): Promise<{
  endpoint: string
  accessKey: string
  secretKey: string
  bucket: string
  region: string
} | null> {
  const bundle = await getConnectionBundle(workspaceId, 's3')
  if (bundle.decryptionError) throw new Error(bundle.decryptionError)
  if (!bundle.enabled) return null

  const endpoint = bundle.config.endpoint
  const accessKey = bundle.secrets.accessKey
  const secretKey = bundle.secrets.secretKey
  const bucket = bundle.config.bucket
  const region = bundle.config.region || 'us-east-1'

  if (!endpoint || !accessKey || !secretKey || !bucket) return null
  return { endpoint, accessKey, secretKey, bucket, region }
}

export async function s3ConnectionStatus(workspaceId?: string): Promise<{
  state: 'CONNECTED' | 'NOT_CONFIGURED' | 'ERROR'
  detail: string
}> {
  try {
    const bundle = await getConnectionBundle(workspaceId, 's3')
    if (bundle.decryptionError) {
      return { state: 'ERROR', detail: bundle.decryptionError }
    }
    if (!bundle.enabled) {
      return { state: 'NOT_CONFIGURED', detail: 'S3 storage is disabled for this workspace.' }
    }
    const s3 = await getS3Connection(workspaceId)
    if (!s3) {
      return {
        state: 'NOT_CONFIGURED',
        detail: 'Add endpoint, bucket, access key and secret key in Settings > Connections to use S3.',
      }
    }
    return {
      state: 'CONNECTED',
      detail: `Writing screenshots to S3 bucket "${s3.bucket}".`,
    }
  } catch (err) {
    return { state: 'ERROR', detail: (err as Error).message }
  }
}

function environmentSecrets(provider: ConnectionProviderId): Record<string, string> {
  switch (provider) {
    case 'google-places':
      return compact({ apiKey: env.googleMapsApiKey })
    case 'pagespeed':
      return compact({ apiKey: env.pagespeedApiKey })
    case 'search':
      return compact({ apiKey: env.searchProviderApiKey })
    case 'yelp-fusion':
      return compact({ apiKey: env.yelpFusionApiKey })
    case 'openai':
      return compact({ apiKey: env.openaiApiKey })
    case 's3':
      return compact({ accessKey: env.s3AccessKey, secretKey: env.s3SecretKey })
  }
}

function environmentConfig(provider: ConnectionProviderId): Record<string, string> {
  switch (provider) {
    case 'search':
      return compact({
        kind: rawEnv('SEARCH_PROVIDER_KIND'),
        monthlyLimit: rawEnv('SERPAPI_MONTHLY_LIMIT'),
        yelpDomain: rawEnv('SERPAPI_YELP_DOMAIN'),
        yandexDomain: rawEnv('SERPAPI_YANDEX_DOMAIN'),
        yandexLang: rawEnv('SERPAPI_YANDEX_LANG'),
        yandexLocationId: rawEnv('SERPAPI_YANDEX_LOCATION_ID'),
      })
    case 'openai':
      return compact({ model: rawEnv('OPENAI_VISION_MODEL') })
    case 's3':
      return compact({
        endpoint: env.s3Endpoint,
        bucket: env.s3Bucket,
        region: rawEnv('S3_REGION'),
      })
    default:
      return {}
  }
}

function applyConfigDefaults(
  provider: ConnectionProviderId,
  config: Record<string, string>,
): void {
  const def = getConnectionDefinition(provider)
  for (const field of def.fields) {
    if (field.type !== 'secret' && field.defaultValue && !config[field.key]) {
      config[field.key] = field.defaultValue
    }
  }
}

function rawEnv(key: string): string | undefined {
  const value = process.env[key]
  return value?.trim() || undefined
}

function compact(values: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).flatMap(([key, value]) => {
      const v = typeof value === 'string' ? value.trim() : ''
      return v ? [[key, v]] : []
    }),
  )
}

function jsonRecord(value: Prisma.JsonValue | null | undefined): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, raw]) => {
      if (typeof raw === 'string') return [[key, raw]]
      if (typeof raw === 'number' || typeof raw === 'boolean') return [[key, String(raw)]]
      return []
    }),
  )
}

function encryptSecretMap(secrets: Record<string, string>): string | null {
  const clean = compact(secrets)
  if (Object.keys(clean).length === 0) return null

  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv)
  cipher.setAAD(SECRET_AAD)
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(clean), 'utf8'),
    cipher.final(),
  ])
  const tag = cipher.getAuthTag()

  return [
    SECRET_PREFIX,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':')
}

function decryptSecretMap(value: string): Record<string, string> {
  if (!value.startsWith(`${SECRET_PREFIX}:`)) {
    const trimmed = value.trim()
    return trimmed ? { apiKey: trimmed } : {}
  }

  const [, , ivText, tagText, ciphertextText] = value.split(':')
  if (!ivText || !tagText || !ciphertextText) {
    throw new Error('Saved credential is malformed.')
  }

  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      encryptionKey(),
      Buffer.from(ivText, 'base64url'),
    )
    decipher.setAAD(SECRET_AAD)
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'))
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextText, 'base64url')),
      decipher.final(),
    ]).toString('utf8')
    const parsed = JSON.parse(plaintext) as unknown
    return typeof parsed === 'object' && parsed && !Array.isArray(parsed)
      ? compact(parsed as Record<string, unknown>)
      : {}
  } catch {
    throw new Error('Saved credential could not be decrypted. Check AUTH_SECRET or re-save it.')
  }
}

function encryptionKey(): Buffer {
  return createHash('sha256').update(env.authSecret).digest()
}
