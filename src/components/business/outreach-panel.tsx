'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { MessageSquarePlus, Tag as TagIcon } from 'lucide-react'
import { Badge, Button, Card, CardHeader, Input, Select, Textarea } from '@/components/ui/primitives'
import { STAGE_LABELS } from '@/components/data-table/columns'
import { formatDateTime } from '@/lib/utils'

/**
 * §27 — a lightweight CRM status, notes and tags.
 *
 * This is deliberately a *record* of outreach, not an outreach tool. Nothing
 * here sends an email or a message: the brief is explicit that discovery and
 * contact stay separate, controlled workflows.
 */

const STAGES = Object.keys(STAGE_LABELS)

export function OutreachPanel({
  businessId,
  stage: initialStage,
  tags: initialTags,
  nextFollowUpAt: initialFollowUp,
  notes: initialNotes,
}: {
  businessId: string
  stage: string
  tags: string[]
  nextFollowUpAt: string | null
  notes: Array<{ id: string; body: string; createdAt: string }>
}) {
  const router = useRouter()
  const [stage, setStage] = useState(initialStage)
  const [tags, setTags] = useState(initialTags)
  const [tagDraft, setTagDraft] = useState('')
  const [followUp, setFollowUp] = useState(initialFollowUp?.slice(0, 10) ?? '')
  const [note, setNote] = useState('')
  const [notes, setNotes] = useState(initialNotes)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save(patch: Record<string, unknown>) {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/businesses/${businessId}/outreach`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        setError(json.error ?? 'Could not save')
        return false
      }
      router.refresh()
      return true
    } catch {
      setError('Could not reach the server')
      return false
    } finally {
      setSaving(false)
    }
  }

  async function addNote() {
    const body = note.trim()
    if (!body) return
    const ok = await save({ note: body })
    if (ok) {
      // Optimistic append so the note appears without a full reload.
      setNotes((prev) => [
        { id: `local-${Date.now()}`, body, createdAt: new Date().toISOString() },
        ...prev,
      ])
      setNote('')
    }
  }

  async function addTag() {
    const t = tagDraft.trim()
    if (!t || tags.includes(t)) return
    const next = [...tags, t]
    setTags(next)
    setTagDraft('')
    await save({ tags: next })
  }

  async function removeTag(t: string) {
    const next = tags.filter((x) => x !== t)
    setTags(next)
    await save({ tags: next })
  }

  return (
    <Card>
      <CardHeader
        title="Outreach"
        description="Status tracking only — nothing is sent from here."
      />

      <div className="space-y-3.5 px-5 py-4">
        <div>
          <label className="mb-1.5 block text-2xs uppercase tracking-wide text-subtle">
            Contact status
          </label>
          <Select
            value={stage}
            disabled={saving}
            onChange={async (e) => {
              const next = e.target.value
              setStage(next)
              await save({ stage: next })
            }}
          >
            {STAGES.map((s) => (
              <option key={s} value={s}>
                {STAGE_LABELS[s]}
              </option>
            ))}
          </Select>
        </div>

        <div>
          <label className="mb-1.5 block text-2xs uppercase tracking-wide text-subtle">
            Next follow-up
          </label>
          <Input
            type="date"
            value={followUp}
            onChange={(e) => setFollowUp(e.target.value)}
            onBlur={() =>
              save({
                nextFollowUpAt: followUp ? new Date(followUp).toISOString() : null,
              })
            }
          />
        </div>

        <div>
          <label className="mb-1.5 block text-2xs uppercase tracking-wide text-subtle">
            Tags
          </label>
          <div className="flex gap-1.5">
            <Input
              value={tagDraft}
              onChange={(e) => setTagDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addTag())}
              placeholder="high-value"
              className="h-8 text-[13px]"
            />
            <Button size="sm" onClick={addTag} disabled={!tagDraft.trim()}>
              <TagIcon className="h-3.5 w-3.5" />
            </Button>
          </div>
          {tags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {tags.map((t) => (
                <button key={t} onClick={() => removeTag(t)} title="Remove tag">
                  <Badge tone="outline">{t} ×</Badge>
                </button>
              ))}
            </div>
          )}
        </div>

        <div>
          <label className="mb-1.5 block text-2xs uppercase tracking-wide text-subtle">
            Notes
          </label>
          <Textarea
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Spoke to the practice manager — sending a proposal Thursday."
            className="text-[13px]"
          />
          <Button
            size="sm"
            variant="secondary"
            className="mt-1.5 w-full justify-center"
            onClick={addNote}
            loading={saving}
            disabled={!note.trim()}
          >
            <MessageSquarePlus className="h-3.5 w-3.5" />
            Add note
          </Button>
        </div>

        {error && <p className="text-2xs text-danger">{error}</p>}

        {notes.length > 0 && (
          <ul className="space-y-2 border-t border-border pt-3">
            {notes.map((n) => (
              <li key={n.id} className="rounded-lg bg-surface-2 px-3 py-2">
                <p className="whitespace-pre-wrap text-[13px] leading-5">{n.body}</p>
                <p className="mt-1 text-2xs text-subtle">{formatDateTime(n.createdAt)}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  )
}
