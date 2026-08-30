'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { KeyRound, ShieldCheck } from 'lucide-react'
import { Button, Card, Input, Label } from '@/components/ui/primitives'

/**
 * First sign-in.
 *
 * An account created by an admin arrives with a password that was read out
 * loud, written on a sticky note, or sent over chat. It stops being a secret
 * the moment it is delivered, so the app blocks everything until it is
 * replaced — not a dismissible banner, and not a setting the agent has to find.
 */
export function ChangePasswordGate({ name }: { name: string }) {
  const router = useRouter()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const mismatch = confirm.length > 0 && next !== confirm
  const valid = current.length > 0 && next.length >= 10 && next === confirm

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/crm/profile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'password', current, next }),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error ?? 'Could not change your password')
        return
      }
      router.refresh()
    } catch {
      setError('Could not reach the server')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-5 py-10">
      <Card className="w-full max-w-md p-6">
        <div className="mb-4 flex items-center gap-2.5">
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-accent-soft text-accent">
            <KeyRound className="h-4 w-4" />
          </span>
          <div>
            <h1 className="text-sm font-semibold">Choose your own password</h1>
            <p className="text-2xs text-subtle">Welcome, {name}</p>
          </div>
        </div>

        <p className="mb-4 text-[13px] leading-5 text-muted">
          The password you were given was shared with someone else to reach you,
          so it is not private. Set one only you know before you start working.
        </p>

        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (valid && !busy) void submit()
          }}
        >
          <div>
            <Label htmlFor="cur-pw">The password you were given</Label>
            <Input
              id="cur-pw"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoFocus
            />
          </div>
          <div>
            <Label htmlFor="new-pw">New password</Label>
            <Input
              id="new-pw"
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
            <p className="mt-1 text-2xs text-subtle">
              At least 10 characters, with an uppercase letter, a lowercase
              letter and a number.
            </p>
          </div>
          <div>
            <Label htmlFor="confirm-pw">Confirm new password</Label>
            <Input
              id="confirm-pw"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              aria-invalid={mismatch}
            />
            {mismatch && (
              <p className="mt-1 text-2xs text-danger">These two do not match.</p>
            )}
          </div>

          {error && <p className="text-[13px] text-danger">{error}</p>}

          <Button
            type="submit"
            variant="primary"
            className="w-full justify-center"
            loading={busy}
            disabled={!valid || busy}
          >
            <ShieldCheck className="h-4 w-4" />
            Set password and continue
          </Button>
        </form>
      </Card>
    </div>
  )
}
