'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  AlertCircle, KeyRound, ShieldCheck, UserPlus, UserX, UserCheck,
} from 'lucide-react'
import {
  Badge, Button, Card, Input, Label, Modal, Select,
} from '@/components/ui/primitives'
import { CopyValue } from '@/components/crm/copy-value'
import { formatDateTime, formatNumber } from '@/lib/utils'
import type { Role } from '@prisma/client'

/**
 * Team administration.
 *
 * The one screen where accounts come into existence. Two things are handled
 * carefully here because getting them wrong is expensive:
 *
 * - The temporary password is shown **once**, in a panel that stays until it is
 *   dismissed, with a copy button. It is only stored as a hash, so there is no
 *   second chance to read it — the UI says so plainly rather than letting
 *   someone navigate away and find out later.
 * - Disabling is offered instead of deleting. An agent's call history is what
 *   the reports are built from; the copy explains that rather than presenting
 *   a delete button that would quietly take a month of records with it.
 */

export interface TeamMemberView {
  userId: string
  membershipId: string
  email: string
  name: string | null
  jobTitle: string | null
  phone: string | null
  avatarPath: string | null
  role: Role
  isActive: boolean
  mustChangePassword: boolean
  lastLoginAt: Date | string | null
  createdAt: Date | string
  assignedLeads: number
  callsAllTime: number
}

const ROLE_HELP: Record<string, string> = {
  OWNER: 'Full control, including billing and ownership.',
  ADMIN: 'Runs the workspace: discovery, exports, team and reports.',
  MEMBER: 'Works leads and runs discovery, but cannot manage the team.',
  AGENT: 'Agent app only — works an assigned queue. No discovery, export or import.',
  VIEWER: 'Read-only. Cannot log calls.',
}

const ROLE_TONE: Record<string, 'accent' | 'info' | 'neutral' | 'outline'> = {
  OWNER: 'accent',
  ADMIN: 'accent',
  MEMBER: 'info',
  AGENT: 'info',
  VIEWER: 'neutral',
}

export function TeamManager({
  initialMembers,
  actorRole,
  actorId,
}: {
  initialMembers: TeamMemberView[]
  actorRole: Role
  actorId: string
}) {
  const router = useRouter()
  const [members, setMembers] = useState(initialMembers)
  const [createOpen, setCreateOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [credential, setCredential] = useState<{ email: string; password: string } | null>(null)

  const grantable: Role[] =
    actorRole === 'OWNER'
      ? ['ADMIN', 'MEMBER', 'AGENT', 'VIEWER']
      : ['MEMBER', 'AGENT', 'VIEWER']

  async function refresh() {
    const res = await fetch('/api/crm/team')
    if (res.ok) setMembers((await res.json()).members)
    router.refresh()
  }

  async function post(body: unknown, label: string): Promise<Record<string, unknown> | null> {
    setBusy(label)
    setError(null)
    try {
      const res = await fetch('/api/crm/team', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error ?? 'Something went wrong')
        return null
      }
      await refresh()
      return json
    } catch {
      setError('Could not reach the server')
      return null
    } finally {
      setBusy(null)
    }
  }

  const active = members.filter((m) => m.isActive)
  const disabled = members.filter((m) => !m.isActive)

  return (
    <div className="space-y-4">
      {credential && (
        <Card className="border-accent/40 bg-accent-soft/40 p-4">
          <div className="flex items-start gap-3">
            <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold">
                Temporary password for {credential.email}
              </div>
              <p className="mt-0.5 text-[13px] text-muted">
                Give this to them now — it is stored only as a hash and cannot be
                shown again. They will be asked to change it when they sign in.
              </p>
              <div className="mt-2 inline-flex items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-1.5">
                <CopyValue value={credential.password} mono className="text-sm font-semibold" />
              </div>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setCredential(null)}>
              Done
            </Button>
          </div>
        </Card>
      )}

      {error && (
        <Card className="border-danger/40 p-3">
          <div className="flex items-start gap-2 text-[13px] text-danger">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        </Card>
      )}

      <div className="flex items-center justify-between">
        <div className="text-[13px] text-muted">
          {formatNumber(active.length)} active
          {disabled.length > 0 && ` · ${formatNumber(disabled.length)} disabled`}
        </div>
        <Button variant="primary" onClick={() => setCreateOpen(true)}>
          <UserPlus className="h-4 w-4" />
          Add person
        </Button>
      </div>

      <Card className="overflow-hidden">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-border bg-surface-2 text-2xs uppercase tracking-wide text-muted">
              <th className="px-5 py-2.5 text-left font-semibold">Person</th>
              <th className="px-3 py-2.5 text-left font-semibold">Role</th>
              <th className="px-3 py-2.5 text-right font-semibold">Leads</th>
              <th className="px-3 py-2.5 text-right font-semibold">Calls</th>
              <th className="px-3 py-2.5 text-left font-semibold">Last sign-in</th>
              <th className="px-5 py-2.5 text-right font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <MemberRow
                key={m.userId}
                member={m}
                actorRole={actorRole}
                isSelf={m.userId === actorId}
                grantable={grantable}
                busy={busy === m.userId}
                onRole={(role) => post({ action: 'update', userId: m.userId, role }, m.userId)}
                onToggleActive={() =>
                  post({ action: 'update', userId: m.userId, isActive: !m.isActive }, m.userId)
                }
                onReset={async () => {
                  const json = await post(
                    { action: 'reset-password', userId: m.userId },
                    m.userId,
                  )
                  if (json?.temporaryPassword) {
                    setCredential({
                      email: m.email,
                      password: String(json.temporaryPassword),
                    })
                  }
                }}
              />
            ))}
          </tbody>
        </table>
      </Card>

      <CreateMemberDialog
        open={createOpen}
        grantable={grantable}
        onClose={() => setCreateOpen(false)}
        onCreate={async (input) => {
          const json = await post({ action: 'create', ...input }, 'create')
          if (json?.temporaryPassword) {
            setCredential({
              email: String(json.email),
              password: String(json.temporaryPassword),
            })
            setCreateOpen(false)
          }
        }}
        busy={busy === 'create'}
      />
    </div>
  )
}

function MemberRow({
  member,
  actorRole,
  isSelf,
  grantable,
  busy,
  onRole,
  onToggleActive,
  onReset,
}: {
  member: TeamMemberView
  actorRole: Role
  isSelf: boolean
  grantable: Role[]
  busy: boolean
  onRole: (role: Role) => void
  onToggleActive: () => void
  onReset: () => void
}) {
  // An admin cannot act on an owner or another admin; the controls are disabled
  // rather than hidden, so it is clear the row exists and why it is untouchable.
  const canEdit =
    !isSelf && (actorRole === 'OWNER' || (member.role !== 'OWNER' && member.role !== 'ADMIN'))

  return (
    <tr className="border-b border-border last:border-0">
      <td className="px-5 py-3">
        <div className="flex items-center gap-2.5">
          <Avatar member={member} />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate font-medium">{member.name ?? member.email}</span>
              {isSelf && <Badge tone="outline">You</Badge>}
              {!member.isActive && <Badge tone="warn">Disabled</Badge>}
              {member.mustChangePassword && member.isActive && (
                <Badge tone="info" title="Will be asked to set a new password at sign-in">
                  New password pending
                </Badge>
              )}
            </div>
            <div className="truncate text-2xs text-subtle">
              {member.email}
              {member.jobTitle && ` · ${member.jobTitle}`}
            </div>
          </div>
        </div>
      </td>

      <td className="px-3 py-3">
        {canEdit ? (
          <Select
            value={member.role}
            disabled={busy}
            onChange={(e) => onRole(e.target.value as Role)}
            className="h-7 w-[110px] text-[13px]"
          >
            {(grantable.includes(member.role)
              ? grantable
              : [member.role, ...grantable]
            ).map((r) => (
              <option key={r} value={r}>
                {r.charAt(0) + r.slice(1).toLowerCase()}
              </option>
            ))}
          </Select>
        ) : (
          <Badge tone={ROLE_TONE[member.role] ?? 'neutral'} title={ROLE_HELP[member.role]}>
            {member.role === 'OWNER' && <ShieldCheck className="h-3 w-3" />}
            {member.role.charAt(0) + member.role.slice(1).toLowerCase()}
          </Badge>
        )}
      </td>

      <td className="tnum px-3 py-3 text-right">{formatNumber(member.assignedLeads)}</td>
      <td className="tnum px-3 py-3 text-right text-muted">{formatNumber(member.callsAllTime)}</td>
      <td className="px-3 py-3 text-muted">
        {member.lastLoginAt ? formatDateTime(member.lastLoginAt) : 'Never'}
      </td>

      <td className="px-5 py-3">
        <div className="flex justify-end gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            disabled={!canEdit || busy}
            onClick={onReset}
            title="Issue a new temporary password"
          >
            <KeyRound className="h-3.5 w-3.5" />
            Reset
          </Button>
          <Button
            size="sm"
            variant={member.isActive ? 'ghost' : 'secondary'}
            disabled={!canEdit || busy}
            onClick={onToggleActive}
            title={
              member.isActive
                ? 'Disable this account. History is kept; their leads return to the pool.'
                : 'Re-enable this account'
            }
          >
            {member.isActive ? (
              <>
                <UserX className="h-3.5 w-3.5" />
                Disable
              </>
            ) : (
              <>
                <UserCheck className="h-3.5 w-3.5" />
                Enable
              </>
            )}
          </Button>
        </div>
      </td>
    </tr>
  )
}

export function Avatar({
  member,
  size = 28,
}: {
  member: { userId?: string; id?: string; name: string | null; email: string; avatarPath: string | null }
  size?: number
}) {
  const id = member.userId ?? member.id
  const initials = (member.name ?? member.email)
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p.charAt(0).toUpperCase())
    .join('')

  if (member.avatarPath && id) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={`/api/crm/avatar/${id}`}
        alt=""
        width={size}
        height={size}
        style={{ width: size, height: size }}
        className="shrink-0 rounded-full border border-border object-cover"
      />
    )
  }

  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-accent-soft font-semibold text-accent"
    >
      {initials}
    </span>
  )
}

function CreateMemberDialog({
  open,
  grantable,
  busy,
  onClose,
  onCreate,
}: {
  open: boolean
  grantable: Role[]
  busy: boolean
  onClose: () => void
  onCreate: (input: {
    email: string
    name: string
    role: Role
    jobTitle: string | null
    phone: string | null
  }) => void
}) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [role, setRole] = useState<Role>('AGENT')
  const [jobTitle, setJobTitle] = useState('')
  const [phone, setPhone] = useState('')

  const valid = email.includes('@') && name.trim().length > 0

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add someone to the workspace"
      description="They will receive a temporary password shown once on the next screen."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!valid || busy}
            onClick={() =>
              onCreate({
                email: email.trim(),
                name: name.trim(),
                role,
                jobTitle: jobTitle.trim() || null,
                phone: phone.trim() || null,
              })
            }
          >
            Create account
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <Label htmlFor="new-name">Full name</Label>
          <Input
            id="new-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ayesha Khan"
            autoFocus
          />
        </div>
        <div>
          <Label htmlFor="new-email">Email</Label>
          <Input
            id="new-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="ayesha@example.com"
          />
          <p className="mt-1 text-2xs text-subtle">This is what they sign in with.</p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="new-title">Job title</Label>
            <Input
              id="new-title"
              value={jobTitle}
              onChange={(e) => setJobTitle(e.target.value)}
              placeholder="Sales agent"
            />
          </div>
          <div>
            <Label htmlFor="new-phone">Phone</Label>
            <Input
              id="new-phone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="Optional"
            />
          </div>
        </div>
        <div>
          <Label htmlFor="new-role">Role</Label>
          <Select id="new-role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {grantable.map((r) => (
              <option key={r} value={r}>
                {r.charAt(0) + r.slice(1).toLowerCase()}
              </option>
            ))}
          </Select>
          <p className="mt-1 text-2xs text-subtle">{ROLE_HELP[role]}</p>
        </div>
      </div>
    </Modal>
  )
}
