'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import Link from 'next/link'
import { LogOut, Plus, User as UserIcon } from 'lucide-react'
import { Button } from '@/components/ui/primitives'

export function Topbar({
  email,
  userName,
  title,
}: {
  email: string
  userName: string | null
  title?: string
}) {
  const router = useRouter()
  const [signingOut, setSigningOut] = useState(false)

  async function signOut() {
    setSigningOut(true)
    await fetch('/api/auth/logout', { method: 'POST' })
    router.push('/login')
    router.refresh()
  }

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-5">
      <div className="min-w-0">
        {title && (
          <h1 className="truncate text-[15px] font-semibold tracking-tight">{title}</h1>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Link href="/discovery/new">
          <Button variant="primary" size="sm">
            <Plus className="h-3.5 w-3.5" />
            New Discovery
          </Button>
        </Link>

        <div className="mx-1 h-5 w-px bg-border" />

        <div className="flex items-center gap-2 pr-1">
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-surface-2 text-subtle">
            <UserIcon className="h-3.5 w-3.5" />
          </div>
          <div className="hidden leading-tight sm:block">
            <div className="text-2xs font-medium">{userName ?? 'Account'}</div>
            <div className="text-2xs text-subtle">{email}</div>
          </div>
        </div>

        <Button
          variant="ghost"
          size="icon"
          onClick={signOut}
          loading={signingOut}
          title="Sign out"
          aria-label="Sign out"
        >
          {!signingOut && <LogOut className="h-4 w-4" />}
        </Button>
      </div>
    </header>
  )
}
