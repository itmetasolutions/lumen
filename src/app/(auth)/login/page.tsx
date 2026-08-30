import Link from 'next/link'
import { prisma } from '@/server/db/client'
import { AuthForm } from '../auth-form'

export const metadata = { title: 'Sign in' }

export default async function LoginPage() {
  // If nobody has registered yet, point the first visitor at registration
  // rather than letting them fail a login against an empty database.
  const userCount = await prisma.user.count().catch(() => -1)

  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight">Sign in</h1>
      <p className="mt-1.5 text-[13px] text-muted">
        Access your workspace and lead database.
      </p>

      {userCount === 0 && (
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
        <AuthForm mode="login" />
      </div>

      <p className="mt-6 text-[13px] text-muted">
        Need a workspace?{' '}
        <Link
          href="/register"
          className="font-medium text-accent underline-offset-2 hover:underline"
        >
          Create an account
        </Link>
      </p>
    </div>
  )
}
