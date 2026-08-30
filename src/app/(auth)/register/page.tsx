import Link from 'next/link'
import { AuthForm } from '../auth-form'

export const metadata = { title: 'Create workspace' }

export default function RegisterPage() {
  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight">Create your workspace</h1>
      <p className="mt-1.5 text-[13px] text-muted">
        You will own this workspace. All discovered businesses, audits and saved views
        belong to it.
      </p>

      <div className="mt-6">
        <AuthForm mode="register" />
      </div>

      <p className="mt-6 text-[13px] text-muted">
        Already have an account?{' '}
        <Link
          href="/login"
          className="font-medium text-accent underline-offset-2 hover:underline"
        >
          Sign in
        </Link>
      </p>
    </div>
  )
}
