import 'server-only'
import { cookies } from 'next/headers'
import { SignJWT, jwtVerify } from 'jose'
import { env, isProd } from '@/server/env'

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

export async function setSessionCookie(payload: SessionPayload): Promise<void> {
  const token = await createSessionToken(payload)
  const store = await cookies()
  store.set(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd(),
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
