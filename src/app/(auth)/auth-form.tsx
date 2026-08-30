'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Input, Label } from '@/components/ui/primitives'

export function AuthForm({
  mode,
  /** Where to go after signing in; already validated as an in-app path. */
  next,
}: {
  mode: 'login' | 'register'
  next?: string | null
}) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    setLoading(true)

    const form = new FormData(e.currentTarget)
    const payload =
      mode === 'login'
        ? {
            email: String(form.get('email') ?? ''),
            password: String(form.get('password') ?? ''),
          }
        : {
            email: String(form.get('email') ?? ''),
            password: String(form.get('password') ?? ''),
            name: String(form.get('name') ?? ''),
            workspaceName: String(form.get('workspaceName') ?? '') || 'My Workspace',
          }

    try {
      const res = await fetch(`/api/auth/${mode}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json().catch(() => ({}))

      if (!res.ok) {
        setError(data.error ?? 'Something went wrong')
        setLoading(false)
        return
      }

      // Agents and supervisors land in different applications. The server
      // decides which, from the membership role — the client has no session yet
      // and cannot know.
      // An explicit destination wins — it is where they were headed before
      // being asked to sign in. Otherwise the server picks by role.
      router.push(
        next ?? (typeof data.redirectTo === 'string' ? data.redirectTo : '/dashboard'),
      )
      router.refresh()
    } catch {
      setError('Could not reach the server. Is it running?')
      setLoading(false)
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {mode === 'register' && (
        <>
          <div>
            <Label htmlFor="name" hint="optional">
              Your name
            </Label>
            <Input id="name" name="name" autoComplete="name" placeholder="Alex Morgan" />
          </div>
          <div>
            <Label htmlFor="workspaceName">Workspace name</Label>
            <Input
              id="workspaceName"
              name="workspaceName"
              required
              defaultValue="My Workspace"
              placeholder="Acme Agency"
            />
          </div>
        </>
      )}

      <div>
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          placeholder="you@agency.com"
        />
      </div>

      <div>
        <Label
          htmlFor="password"
          hint={mode === 'register' ? '10+ chars, upper, lower, number' : undefined}
        >
          Password
        </Label>
        <Input
          id="password"
          name="password"
          type="password"
          required
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
        />
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-danger/25 bg-danger/10 px-3 py-2.5 text-[13px] leading-5 text-danger"
        >
          {error}
        </div>
      )}

      <Button type="submit" variant="primary" size="lg" loading={loading} className="w-full justify-center">
        {mode === 'login' ? 'Sign in' : 'Create workspace'}
      </Button>
    </form>
  )
}
