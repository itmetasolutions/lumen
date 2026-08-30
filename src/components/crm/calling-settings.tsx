'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check, Clock, RotateCcw, Shuffle, Timer } from 'lucide-react'
import {
  Button, Card, CardHeader, Checkbox, Input, Label, Select,
} from '@/components/ui/primitives'

/**
 * How the calling operation runs.
 *
 * These settings drive the unattended maintenance pass, so each one says what
 * it will actually cause to happen rather than naming a field. A supervisor
 * turning on auto-assignment is agreeing that leads will move without them,
 * and the copy should make that plain before they do.
 */

interface Settings {
  reportingTimeZone: string
  reportingHour: number
  autoAssignEnabled: boolean
  autoAssignTarget: number
  reclaimEnabled: boolean
  reclaimStaleDays: number
  requireClockIn: boolean
}

export function CallingSettings({
  initial,
  timeZones,
  agentCount,
}: {
  initial: Settings
  timeZones: string[]
  agentCount: number
}) {
  const router = useRouter()
  const [settings, setSettings] = useState(initial)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const dirty = JSON.stringify(settings) !== JSON.stringify(initial)

  function set<K extends keyof Settings>(key: K, value: Settings[K]) {
    setSettings((s) => ({ ...s, [key]: value }))
    setSaved(false)
  }

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/crm/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(settings),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error ?? 'Could not save these settings')
        return
      }
      setSaved(true)
      router.refresh()
    } catch {
      setError('Could not reach the server')
    } finally {
      setSaving(false)
    }
  }

  // The browser's own zone, offered as a shortcut when it is not already listed.
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const zoneOptions = timeZones.includes(localZone) ? timeZones : [localZone, ...timeZones]

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold">Calling</h2>
        <p className="mt-0.5 text-[13px] text-muted">
          How the working day is measured, and what the system does on its own
          between shifts.
        </p>
      </div>

      <Card>
        <CardHeader
          title="The working day"
          description="Reports are cut on this timezone, so a day means the agent's day."
        />
        <div className="grid gap-4 px-5 py-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="tz">
              <Clock className="mr-1 inline h-3.5 w-3.5" />
              Reporting timezone
            </Label>
            <Select
              id="tz"
              value={settings.reportingTimeZone}
              onChange={(e) => set('reportingTimeZone', e.target.value)}
            >
              {zoneOptions.map((z) => (
                <option key={z} value={z}>
                  {z}
                  {z === localZone ? ' (this computer)' : ''}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="hour">Roll up the day after</Label>
            <Select
              id="hour"
              value={String(settings.reportingHour)}
              onChange={(e) => set('reportingHour', Number(e.target.value))}
            >
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, '0')}:00
                </option>
              ))}
            </Select>
            <p className="mt-1 text-2xs text-subtle">
              Each agent&apos;s day is written up once this hour passes. A day
              missed because nothing was running is caught up automatically.
            </p>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Handing out leads"
          description="Top agents back up automatically as they work through their queue."
        />
        <div className="space-y-4 px-5 py-4">
          <Toggle
            checked={settings.autoAssignEnabled}
            onChange={(v) => set('autoAssignEnabled', v)}
            label="Assign unworked leads to agents automatically"
            hint={
              agentCount === 0
                ? 'There are no agents in this workspace yet, so this will do nothing until you add one.'
                : `Runs every few minutes across ${agentCount} agent${agentCount === 1 ? '' : 's'}. Leads with no phone number, and leads marked do-not-call, are never handed out.`
            }
          />

          {settings.autoAssignEnabled && (
            <div className="max-w-[220px]">
              <Label htmlFor="target">
                <Shuffle className="mr-1 inline h-3.5 w-3.5" />
                Open leads per agent
              </Label>
              <Input
                id="target"
                type="number"
                min={1}
                max={2000}
                value={settings.autoAssignTarget}
                onChange={(e) => set('autoAssignTarget', Number(e.target.value))}
              />
              <p className="mt-1 text-2xs text-subtle">
                Agents are topped back up to this number, best leads first. An
                agent already holding this many gets nothing new.
              </p>
            </div>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Taking leads back"
          description="A lead sitting untouched in someone's queue is not being worked."
        />
        <div className="space-y-4 px-5 py-4">
          <Toggle
            checked={settings.reclaimEnabled}
            onChange={(v) => set('reclaimEnabled', v)}
            label="Return untouched leads to the pool"
            hint="A lead with a scheduled follow-up in the future is never taken back — that one is being worked, just not today."
          />

          {settings.reclaimEnabled && (
            <div className="max-w-[220px]">
              <Label htmlFor="stale">
                <RotateCcw className="mr-1 inline h-3.5 w-3.5" />
                Untouched for
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  id="stale"
                  type="number"
                  min={1}
                  max={365}
                  value={settings.reclaimStaleDays}
                  onChange={(e) => set('reclaimStaleDays', Number(e.target.value))}
                />
                <span className="text-[13px] text-muted">days</span>
              </div>
            </div>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Shifts"
          description="Whether agents must be on the clock to record work."
        />
        <div className="px-5 py-4">
          <Toggle
            checked={settings.requireClockIn}
            onChange={(v) => set('requireClockIn', v)}
            label="Require agents to clock in before logging calls"
            hint="With this off, calls logged outside a shift still count toward the day's totals, but there is no active time to measure them against — calls per hour will be blank."
          />
        </div>
      </Card>

      {error && (
        <Card className="border-danger/40 px-4 py-2.5 text-[13px] text-danger">{error}</Card>
      )}

      <div className="flex items-center gap-3">
        <Button
          variant="primary"
          loading={saving}
          disabled={!dirty || saving}
          onClick={() => void save()}
        >
          Save settings
        </Button>
        {saved && !dirty && (
          <span className="inline-flex items-center gap-1 text-[13px] text-ok">
            <Check className="h-3.5 w-3.5" />
            Saved
          </span>
        )}
        <span className="ml-auto inline-flex items-center gap-1.5 text-2xs text-subtle">
          <Timer className="h-3 w-3" />
          Automatic tasks run on the background worker, roughly every five minutes.
        </span>
      </div>
    </div>
  )
}

/**
 * A switch with its consequence written underneath.
 *
 * Each of these settings makes the system act on its own, so the hint is not
 * decoration — it is the difference between turning something on and knowing
 * what it will do.
 */
function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean
  onChange: (value: boolean) => void
  label: string
  hint?: string
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <Checkbox
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5"
      />
      <span className="min-w-0">
        <span className="block text-[13px] font-medium">{label}</span>
        {hint && <span className="mt-0.5 block text-2xs leading-4 text-subtle">{hint}</span>}
      </span>
    </label>
  )
}
