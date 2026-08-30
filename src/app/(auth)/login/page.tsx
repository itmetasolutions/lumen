import Link from 'next/link'
import { prisma } from '@/server/db/client'
import { AuthForm } from '../auth-form'

export const metadata = { title: 'Sign in' }

/**
 * Sign in.
 *
 * The `next` parameter carries where the visitor was headed before being asked
 * to authenticate. It does double duty: it returns them there afterwards, and
 * when the destination is the agent app it suppresses the registration link —
 * an agent's account is created for them by a supervisor, so offering to make a
 * new workspace is an invitation to strand themselves in an empty one.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>
}) {
  const { next } = await searchParams

  // If nobody has registered yet, point the first visitor at registration
  // rather than letting them fail a login against an empty database.
  const userCount = await prisma.user.count().catch(() => -1)

  // Only ever an in-app path, never an absolute URL — an open redirect here
  // would let a crafted link bounce someone off this app after signing in.
  const destination = next && /^\/[^/\\]/.test(next) ? next : null
  const isAgentApp = destination?.startsWith('/agent') ?? false

  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight">Sign in</h1>
      <p className="mt-1.5 text-[13px] text-muted">
        {isAgentApp
          ? 'Sign in with the account your supervisor set up for you.'
          : 'Access your workspace and lead database.'}
      </p>

      {userCount === 0 && !isAgentApp && (
        <div className="mt-5 rounded-lg border border-accent/25 bg-accent-soft px-3.5 py-3 text-[13px] leading-5 text-accent">
          No accounts exist yet.{' '}
          <Link href="/register" className="font-semibold underline underline-offset-2">
            Create the first workspace
          </Link>{' '}
          to get started.
        </div>
      )}

      {userCount === -1 && (
        <div className="mt-5 rounded-lg border border-danger/25 bg-danger/10 px-3.5 py-3 text-[13px] leading-5 text-danger">
          The database is not reachable. Check <code>DATABASE_URL</code> and run{' '}
          <code>npm run db:push</code>.
        </div>
      )}

      <div className="mt-6">
        <AuthForm mode="login" next={destination} />
      </div>

      {isAgentApp ? (
        <p className="mt-6 text-[13px] text-muted">
          Cannot sign in? Ask your supervisor to check your account, or to issue
          you a new password.
        </p>
      ) : (
        <p className="mt-6 text-[13px] text-muted">
          Need a workspace?{' '}
          <Link
            href="/register"
            className="font-medium text-accent underline-offset-2 hover:underline"
          >
            Create an account
          </Link>
        </p>
      )}
    </div>
  )
}
