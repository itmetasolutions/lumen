import 'server-only'
import { cookies } from 'next/headers'
import { SignJWT, jwtVerify } from 'jose'
import { env } from '@/server/env'

const COOKIE = 'lumen_session'
const MAX_AGE_SECONDS = 60 * 60 * 24 * 14 // 14 days

export interface SessionPayload {
  userId: string
  workspaceId: string
  email: string
}

function secretKey(): Uint8Array {
  return new TextEncoder().encode(env.authSecret)
}

export async function createSessionToken(payload: SessionPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_SECONDS}s`)
    .sign(secretKey())
}

/**
 * Whether the session cookie may carry the `Secure` attribute.
 *
 * This has to follow the actual connection, not NODE_ENV. A `Secure` cookie is
 * discarded by the browser on any origin that is not a secure context, and the
 * agent app reaches its Lumen over plain HTTP on the LAN — `http://192.168.x.x`.
 * Keying it on NODE_ENV meant the packaged build always set `Secure`, the
 * browser dropped the cookie without a word, and signing in bounced straight
 * back to an empty login form. The desktop app itself never showed this,
 * because `127.0.0.1` *is* a secure context and accepts the cookie.
 *
 * Deriving it from the request keeps the protection where it belongs: a real
 * HTTPS deployment still gets `Secure`, and only genuinely plaintext
 * connections go without.
 */
export function isSecureRequest(req: Request): boolean {
  // A proxy or tunnel terminating TLS reports the original scheme here, and it
  // may be a comma-separated list when several hops are involved.
  const forwarded = req.headers.get('x-forwarded-proto')
  if (forwarded) return forwarded.split(',')[0]!.trim().toLowerCase() === 'https'

  try {
    return new URL(req.url).protocol === 'https:'
  } catch {
    // An unparseable URL is not evidence of TLS; err towards a cookie that
    // works rather than one silently discarded.
    return false
  }
}

export async function setSessionCookie(
  payload: SessionPayload,
  options: { secure: boolean },
): Promise<void> {
  const token = await createSessionToken(payload)
  const store = await cookies()
  store.set(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: options.secure,
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  })
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies()
  store.delete(COOKIE)
}

export async function readSession(): Promise<SessionPayload | null> {
  const store = await cookies()
  const token = store.get(COOKIE)?.value
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, secretKey(), { algorithms: ['HS256'] })
    if (
      typeof payload.userId !== 'string' ||
      typeof payload.workspaceId !== 'string' ||
      typeof payload.email !== 'string'
    ) {
      return null
    }
    return {
      userId: payload.userId,
      workspaceId: payload.workspaceId,
      email: payload.email,
    }
  } catch {
    return null
  }
}
