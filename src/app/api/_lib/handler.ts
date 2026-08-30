import 'server-only'
import { NextResponse } from 'next/server'
import { ZodError, type ZodTypeAny, type output as ZodOutput } from 'zod'
import { HttpError, requireApiAuth, type AuthContext } from '@/server/auth/guard'
import { rateLimit, clientKey, LIMITS } from '@/server/http/rate-limit'

/**
 * Shared route-handler plumbing.
 *
 * Every API route goes through this so that authentication, workspace scoping,
 * input validation, rate limiting and error shaping are uniform — and so no
 * route can accidentally omit one of them (§29).
 */

export interface RouteContext<T> {
  auth: AuthContext
  body: T
  req: Request
}

type Limit = keyof typeof LIMITS

interface RouteOptions<S extends ZodTypeAny> {
  schema?: S
  limit?: Limit
  /** Set false for the auth routes themselves. */
  authenticated?: boolean
}

/**
 * `body` is typed as the schema's *output* (post-parse), so zod defaults are
 * present and non-optional inside the handler. Inferring the input type here
 * would make every defaulted field `| undefined` for no reason.
 */
export function route<S extends ZodTypeAny = ZodTypeAny>(
  options: RouteOptions<S>,
  handler: (ctx: RouteContext<ZodOutput<S>>) => Promise<Response | unknown>,
) {
  return async (req: Request): Promise<Response> => {
    try {
      const limitKind: Limit = options.limit ?? 'read'
      const limitConfig = LIMITS[limitKind]
      const rl = rateLimit(
        clientKey(req, `${limitKind}:${new URL(req.url).pathname}`),
        limitConfig.limit,
        limitConfig.windowMs,
      )
      if (!rl.ok) {
        return NextResponse.json(
          { error: 'Too many requests. Slow down and try again shortly.' },
          { status: 429, headers: { 'retry-after': String(rl.retryAfterSeconds) } },
        )
      }

      const auth = options.authenticated === false
        ? (null as unknown as AuthContext)
        : await requireApiAuth()

      let body = undefined as ZodOutput<S>
      if (options.schema) {
        const raw = await readBody(req)
        body = options.schema.parse(raw)
      }

      const result = await handler({ auth, body, req })
      if (result instanceof Response) return result
      return NextResponse.json(result ?? { ok: true })
    } catch (err) {
      return errorResponse(err)
    }
  }
}

async function readBody(req: Request): Promise<unknown> {
  if (req.method === 'GET' || req.method === 'HEAD') {
    const url = new URL(req.url)
    const q = url.searchParams.get('q')
    if (q) {
      try {
        return JSON.parse(q)
      } catch {
        throw new HttpError(400, 'Malformed query parameter "q"')
      }
    }
    return Object.fromEntries(url.searchParams.entries())
  }
  const text = await req.text()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON')
  }
}

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return NextResponse.json({ error: err.message }, { status: err.status })
  }
  if (err instanceof ZodError) {
    return NextResponse.json(
      {
        error: 'Invalid request',
        // Field-level detail so the UI can point at the offending control.
        details: err.errors.map((e) => ({
          path: e.path.join('.'),
          message: e.message,
        })),
      },
      { status: 400 },
    )
  }

  const message = err instanceof Error ? err.message : 'Unexpected error'
  // Never leak stack traces or driver internals to the client.
  console.error('[api]', err)
  return NextResponse.json(
    { error: process.env.NODE_ENV === 'production' ? 'Something went wrong' : message },
    { status: 500 },
  )
}

export { HttpError }
