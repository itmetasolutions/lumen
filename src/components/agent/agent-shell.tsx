'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import {
  BarChart3, LogOut, Pause, PhoneCall, Play, User as UserIcon,
} from 'lucide-react'
import { Badge, Button } from '@/components/ui/primitives'
import { Avatar } from '@/components/crm/team-manager'
import { ChangePasswordGate } from '@/components/agent/change-password-gate'
import { cn } from '@/lib/utils'

/**
 * Agent shell.
 *
 * The shift clock lives here rather than on a page, because it has to keep
 * running as the agent moves between the queue and a lead. It does three things:
 *
 * 1. Sends a heartbeat every 30 seconds, which is how the server accrues active
 *    time — the client never reports a duration, only that it is still alive.
 * 2. Reports which lead is open, so the supervisor's floor view is accurate
 *    without the agent doing anything.
 * 3. Goes idle after five minutes without input, so a shift left running while
 *    someone is at lunch does not accumulate active time.
 *
 * The clock is honest in both directions: it does not credit time the agent was
 * not working, and it does not stop crediting time just because they are
 * reading a lead rather than clicking.
 */

const HEARTBEAT_MS = 30_000
const IDLE_AFTER_MS = 5 * 60_000

interface SessionView {
  id: string
  startedAt: string
  activeSeconds: number
  shiftSeconds: number
}

interface QueueCounts {
  overdue: number
  today: number
  new: number
  working: number
  upcoming: number
  total: number
}

function duration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
}

export function AgentShell({
  user,
  workspaceName,
  isSupervisor,
  initialSession,
  counts,
  children,
}: {
  user: {
    id: string
    name: string | null
    email: string
    avatarPath: string | null
    mustChangePassword: boolean
  }
  workspaceName: string
  isSupervisor: boolean
  initialSession: SessionView | null
  counts: QueueCounts
  children: React.ReactNode
}) {
  const pathname = usePathname()
  const router = useRouter()
  const [session, setSession] = useState<SessionView | null>(initialSession)
  const [busy, setBusy] = useState(false)
  const [idle, setIdle] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Ticks the displayed clock between heartbeats so the numbers move.
  const [tick, setTick] = useState(0)
  // False through the server render and the first client render, so both
  // produce the same markup; the live clock appears immediately afterwards.
  const [mounted, setMounted] = useState(false)
  const lastInput = useRef(Date.now())

  // Which lead is open, derived from the URL — the agent never tells us.
  const currentBusinessId = pathname.startsWith('/agent/lead/')
    ? (pathname.split('/')[3] ?? null)
    : null

  const post = useCallback(
    async (action: string, extra: Record<string, unknown> = {}) => {
      const res = await fetch('/api/crm/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, ...extra }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Request failed')
      return json
    },
    [],
  )

  const heartbeat = useCallback(async () => {
    try {
      const wentIdle = Date.now() - lastInput.current > IDLE_AFTER_MS
      setIdle(wentIdle)
      const json = await post('heartbeat', {
        currentBusinessId,
        idle: wentIdle,
      })
      setSession(json.session ?? null)
      setError(null)
    } catch {
      // A missed heartbeat is not worth interrupting the agent over; the next
      // one will land, and the server treats the gap as a break either way.
    }
  }, [post, currentBusinessId])

  useEffect(() => setMounted(true), [])

  useEffect(() => {
    const mark = () => { lastInput.current = Date.now() }
    const events = ['pointerdown', 'keydown', 'wheel'] as const
    for (const e of events) window.addEventListener(e, mark, { passive: true })
    return () => { for (const e of events) window.removeEventListener(e, mark) }
  }, [])

  useEffect(() => {
    void heartbeat()
    const id = setInterval(() => void heartbeat(), HEARTBEAT_MS)
    return () => clearInterval(id)
  }, [heartbeat])

  useEffect(() => {
    if (!session) return
    const id = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [session])

  async function toggleShift() {
    setBusy(true)
    setError(null)
    try {
      if (session) {
        await post('out')
        setSession(null)
      } else {
        const json = await post('in')
        setSession(json.session)
        lastInput.current = Date.now()
      }
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update your shift')
    } finally {
      setBusy(false)
    }
  }

  const shiftSeconds =
    session && mounted
      ? Math.round((Date.now() - new Date(session.startedAt).getTime()) / 1000)
      : 0
  // `tick` is read so the elapsed time re-renders each second.
  void tick

  const nav = [
    { href: '/agent', label: 'My queue', icon: PhoneCall, count: counts.total, exact: true },
    { href: '/agent/reports', label: 'My results', icon: BarChart3 },
    { href: '/agent/profile', label: 'Profile', icon: UserIcon },
  ]

  if (user.mustChangePassword) {
    return <ChangePasswordGate name={user.name ?? user.email} />
  }

  return (
    <div className="flex min-h-screen flex-col bg-bg">
      <header className="sticky top-0 z-30 border-b border-border bg-surface">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-5">
          <Link href="/agent" className="flex shrink-0 items-center gap-2.5">
            <span className="text-accent">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.6" opacity="0.5" />
                <circle cx="12" cy="12" r="4" fill="currentColor" />
                <path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </span>
            <span className="min-w-0">
              <span className="block text-[13px] font-semibold leading-4">Lumen Agent</span>
              <span className="block truncate text-2xs leading-4 text-subtle">{workspaceName}</span>
            </span>
          </Link>

          <nav className="flex flex-1 items-center gap-1">
            {nav.map((item) => {
              const active = item.exact ? pathname === item.href : pathname.startsWith(item.href)
              const Icon = item.icon
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    'inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-[13px] transition-colors',
                    active
                      ? 'bg-accent-soft font-semibold text-accent'
                      : 'text-muted hover:bg-surface-2 hover:text-fg',
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {item.label}
                  {item.count !== undefined && item.count > 0 && (
                    <span className="tnum rounded bg-surface-2 px-1.5 py-0.5 text-2xs">
                      {item.count}
                    </span>
                  )}
                </Link>
              )
            })}
          </nav>

          <div className="flex shrink-0 items-center gap-3">
            {session ? (
              <div className="flex items-center gap-2 rounded-lg border border-ok/30 bg-ok/10 px-2.5 py-1">
                <span
                  className={cn(
                    'h-2 w-2 rounded-full',
                    idle ? 'bg-warn' : 'animate-pulse bg-ok',
                  )}
                  aria-hidden="true"
                />
                <span className="tnum text-[13px] font-semibold text-ok">
                  {mounted ? duration(shiftSeconds) : '—'}
                </span>
                {idle && <Badge tone="warn">Idle</Badge>}
              </div>
            ) : (
              <Badge tone="neutral">Off shift</Badge>
            )}

            <Button
              size="sm"
              variant={session ? 'secondary' : 'primary'}
              loading={busy}
              onClick={() => void toggleShift()}
            >
              {session ? (
                <>
                  <Pause className="h-3.5 w-3.5" />
                  Clock out
                </>
              ) : (
                <>
                  <Play className="h-3.5 w-3.5" />
                  Clock in
                </>
              )}
            </Button>

            {isSupervisor && (
              <Link href="/dashboard" title="Back to the admin app">
                <Button size="sm" variant="ghost">
                  Admin
                </Button>
              </Link>
            )}

            <Link href="/agent/profile" className="shrink-0" title={user.name ?? user.email}>
              <Avatar member={{ ...user, avatarPath: user.avatarPath }} size={30} />
            </Link>

            <form action="/api/auth/logout" method="post">
              <Button size="sm" variant="ghost" type="submit" title="Sign out">
                <LogOut className="h-3.5 w-3.5" />
              </Button>
            </form>
          </div>
        </div>

        {error && (
          <div className="border-t border-danger/30 bg-danger/10 px-5 py-1.5 text-center text-2xs text-danger">
            {error}
          </div>
        )}
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-5 py-6">{children}</main>
    </div>
  )
}
