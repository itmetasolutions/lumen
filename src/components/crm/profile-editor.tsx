'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Camera, Check, KeyRound } from 'lucide-react'
import { Badge, Button, Card, Input, Label } from '@/components/ui/primitives'
import { Avatar } from '@/components/crm/team-manager'
import type { Role } from '@prisma/client'

/**
 * Self-service profile.
 *
 * Shared by the admin app and the agent app — the same person editing the same
 * account should not meet two different forms. What is *not* here is as
 * deliberate as what is: no role, no workspace, no lead assignments. An account
 * cannot change its own authority.
 */

const MAX_AVATAR_BYTES = 2 * 1024 * 1024

export function ProfileEditor({
  user,
  role,
  workspaceName,
}: {
  user: {
    id: string
    email: string
    name: string | null
    jobTitle: string | null
    phone: string | null
    avatarPath: string | null
  }
  role: Role
  workspaceName: string
}) {
  const router = useRouter()
  const fileInput = useRef<HTMLInputElement>(null)

  const [name, setName] = useState(user.name ?? '')
  const [jobTitle, setJobTitle] = useState(user.jobTitle ?? '')
  const [phone, setPhone] = useState(user.phone ?? '')
  const [avatarPath, setAvatarPath] = useState(user.avatarPath)
  // Bumped after an upload so the browser refetches an avatar at the same URL.
  const [avatarVersion, setAvatarVersion] = useState(0)

  const [savingProfile, setSavingProfile] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [savedProfile, setSavedProfile] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [savingPassword, setSavingPassword] = useState(false)
  const [passwordDone, setPasswordDone] = useState(false)
  const [passwordError, setPasswordError] = useState<string | null>(null)

  const dirty =
    name !== (user.name ?? '') ||
    jobTitle !== (user.jobTitle ?? '') ||
    phone !== (user.phone ?? '')

  async function saveProfile() {
    setSavingProfile(true)
    setError(null)
    setSavedProfile(false)
    try {
      const res = await fetch('/api/crm/profile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'update',
          name,
          jobTitle: jobTitle || null,
          phone: phone || null,
        }),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error ?? 'Could not save your profile')
        return
      }
      setSavedProfile(true)
      router.refresh()
    } catch {
      setError('Could not reach the server')
    } finally {
      setSavingProfile(false)
    }
  }

  async function uploadAvatar(file: File) {
    if (file.size > MAX_AVATAR_BYTES) {
      setError('Pick an image under 2 MB')
      return
    }
    setUploading(true)
    setError(null)
    try {
      const body = new FormData()
      body.append('avatar', file)
      const res = await fetch('/api/crm/profile', { method: 'PUT', body })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error ?? 'Could not upload that image')
        return
      }
      setAvatarPath(json.avatarPath)
      setAvatarVersion((v) => v + 1)
      router.refresh()
    } catch {
      setError('Could not reach the server')
    } finally {
      setUploading(false)
    }
  }

  async function changePassword() {
    setSavingPassword(true)
    setPasswordError(null)
    setPasswordDone(false)
    try {
      const res = await fetch('/api/crm/profile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'password', current, next }),
      })
      const json = await res.json()
      if (!res.ok) {
        setPasswordError(json.error ?? 'Could not change your password')
        return
      }
      setPasswordDone(true)
      setCurrent('')
      setNext('')
      setConfirm('')
    } catch {
      setPasswordError('Could not reach the server')
    } finally {
      setSavingPassword(false)
    }
  }

  const mismatch = confirm.length > 0 && next !== confirm
  const canChangePassword =
    current.length > 0 && next.length >= 10 && next === confirm && !savingPassword

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <div className="flex items-start gap-4">
          <div className="relative">
            <span key={avatarVersion}>
              <Avatar
                member={{ id: user.id, name, email: user.email, avatarPath }}
                size={64}
              />
            </span>
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              disabled={uploading}
              title="Change picture"
              aria-label="Change profile picture"
              className="absolute -bottom-1 -right-1 inline-flex h-6 w-6 items-center justify-center rounded-full border border-border bg-surface text-muted shadow-panel transition-colors hover:text-fg disabled:opacity-50"
            >
              <Camera className="h-3 w-3" />
            </button>
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) void uploadAvatar(file)
                e.target.value = ''
              }}
            />
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold">{name || user.email}</span>
              <Badge tone="outline">{role.charAt(0) + role.slice(1).toLowerCase()}</Badge>
            </div>
            <div className="mt-0.5 text-[13px] text-muted">{user.email}</div>
            <div className="text-2xs text-subtle">{workspaceName}</div>
            {uploading && <div className="mt-1 text-2xs text-muted">Uploading…</div>}
          </div>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Label htmlFor="pf-name">Display name</Label>
            <Input
              id="pf-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                setSavedProfile(false)
              }}
              placeholder="Your name"
            />
          </div>
          <div>
            <Label htmlFor="pf-title">Job title</Label>
            <Input
              id="pf-title"
              value={jobTitle}
              onChange={(e) => {
                setJobTitle(e.target.value)
                setSavedProfile(false)
              }}
              placeholder="Sales agent"
            />
          </div>
          <div>
            <Label htmlFor="pf-phone">Your phone</Label>
            <Input
              id="pf-phone"
              value={phone}
              onChange={(e) => {
                setPhone(e.target.value)
                setSavedProfile(false)
              }}
              placeholder="Optional"
            />
          </div>
        </div>

        {error && <p className="mt-3 text-[13px] text-danger">{error}</p>}

        <div className="mt-4 flex items-center gap-3">
          <Button
            variant="primary"
            loading={savingProfile}
            disabled={!dirty || savingProfile}
            onClick={() => void saveProfile()}
          >
            Save changes
          </Button>
          {savedProfile && !dirty && (
            <span className="inline-flex items-center gap-1 text-[13px] text-ok">
              <Check className="h-3.5 w-3.5" />
              Saved
            </span>
          )}
        </div>
      </Card>

      <Card className="p-5">
        <h2 className="flex items-center gap-2 text-[13px] font-semibold">
          <KeyRound className="h-4 w-4 text-subtle" />
          Password
        </h2>
        <p className="mt-0.5 text-2xs text-subtle">
          Changing this signs nothing else out — your other sessions stay open.
        </p>

        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <div>
            <Label htmlFor="pw-cur">Current</Label>
            <Input
              id="pw-cur"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="pw-new">New</Label>
            <Input
              id="pw-new"
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="pw-confirm">Confirm</Label>
            <Input
              id="pw-confirm"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              aria-invalid={mismatch}
            />
          </div>
        </div>

        <p className="mt-1.5 text-2xs text-subtle">
          At least 10 characters, with an uppercase letter, a lowercase letter
          and a number.
        </p>

        {mismatch && <p className="mt-2 text-[13px] text-danger">The two new passwords do not match.</p>}
        {passwordError && <p className="mt-2 text-[13px] text-danger">{passwordError}</p>}
        {passwordDone && (
          <p className="mt-2 inline-flex items-center gap-1 text-[13px] text-ok">
            <Check className="h-3.5 w-3.5" />
            Password changed
          </p>
        )}

        <Button
          className="mt-3"
          variant="secondary"
          loading={savingPassword}
          disabled={!canChangePassword}
          onClick={() => void changePassword()}
        >
          Change password
        </Button>
      </Card>
    </div>
  )
}
