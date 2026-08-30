'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  Check,
  CheckCircle2,
  EyeOff,
  KeyRound,
  MinusCircle,
  RefreshCw,
  Save,
  Trash2,
  XCircle,
} from 'lucide-react'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Checkbox,
  Input,
  Label,
  Select,
  Skeleton,
} from '@/components/ui/primitives'
import { cn, formatNumber } from '@/lib/utils'

type StatusState = 'CONNECTED' | 'NOT_CONFIGURED' | 'ERROR'
type FieldType = 'text' | 'secret' | 'select'
type Source = 'workspace' | 'environment' | 'none'
type ConnectionSource = Source | 'mixed' | 'disabled'

interface Field {
  key: string
  label: string
  type: FieldType
  required?: boolean
  placeholder?: string
  description?: string
  defaultValue?: string
  value?: string
  hasValue: boolean
  source: Source
  options?: Array<{ value: string; label: string }>
}

interface Connection {
  id: string
  label: string
  description: string
  category: 'Discovery' | 'Performance' | 'AI' | 'Storage'
  enabled: boolean
  hasWorkspaceRecord: boolean
  source: ConnectionSource
  updatedAt: string | null
  fields: Field[]
  decryptionError: string | null
  status: { state: StatusState; detail: string }
  quota?: Quota | null
}

interface Quota {
  configuredLimit: number
  localUsed: number
  localLeft: number | null
  remoteLimit: number | null
  remoteUsed: number | null
  remoteLeft: number | null
  renewalDate: string | null
  full: boolean
  remoteError: string | null
  detail: string
}

interface Payload {
  canEdit: boolean
  connections: Connection[]
}

interface Draft {
  enabled: boolean
  values: Record<string, string>
}

const CATEGORY_ORDER: Connection['category'][] = ['Discovery', 'Performance', 'AI', 'Storage']

export function ConnectionsPanel() {
  const [data, setData] = useState<Payload | null>(null)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/settings/connections', { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error ?? 'Could not load connections')
        return
      }
      setData(json)
      setDrafts(initialDrafts(json.connections))
    } catch {
      setError('Could not reach the server')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const grouped = useMemo(() => {
    const groups = new Map<Connection['category'], Connection[]>()
    for (const category of CATEGORY_ORDER) groups.set(category, [])
    for (const connection of data?.connections ?? []) {
      groups.get(connection.category)?.push(connection)
    }
    return CATEGORY_ORDER.map((category) => ({
      category,
      connections: groups.get(category) ?? [],
    })).filter((group) => group.connections.length > 0)
  }, [data])

  function updateDraft(id: string, patch: Partial<Draft>) {
    setDrafts((current) => ({
      ...current,
      [id]: {
        ...current[id],
        ...patch,
        values: patch.values ?? current[id]?.values ?? {},
      },
    }))
    setSaved(null)
  }

  function setValue(id: string, key: string, value: string) {
    setDrafts((current) => ({
      ...current,
      [id]: {
        enabled: current[id]?.enabled ?? true,
        values: { ...(current[id]?.values ?? {}), [key]: value },
      },
    }))
    setSaved(null)
  }

  async function save(connection: Connection) {
    const draft = drafts[connection.id]
    if (!draft) return

    setSaving(connection.id)
    setError(null)
    try {
      const res = await fetch('/api/settings/connections', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: connection.id,
          enabled: draft.enabled,
          values: draft.values,
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(json.error ?? 'Could not save connection')
        return
      }
      setSaved(connection.id)
      await load()
    } catch {
      setError('Could not reach the server')
    } finally {
      setSaving(null)
    }
  }

  async function remove(connection: Connection) {
    if (!window.confirm(`Remove the saved ${connection.label} connection?`)) return

    setSaving(connection.id)
    setError(null)
    try {
      const res = await fetch(`/api/settings/connections?provider=${encodeURIComponent(connection.id)}`, {
        method: 'DELETE',
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(json.error ?? 'Could not remove connection')
        return
      }
      setSaved(null)
      await load()
    } catch {
      setError('Could not reach the server')
    } finally {
      setSaving(null)
    }
  }

  if (loading && !data) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-40" />
        ))}
      </div>
    )
  }

  if (error && !data) {
    return (
      <Card className="px-5 py-4 text-[13px] text-danger">
        {error}
        <Button className="ml-3" size="sm" onClick={load}>
          Retry
        </Button>
      </Card>
    )
  }

  if (!data) return null

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-[13px] leading-5 text-muted">
          Store API credentials per workspace. Saved secrets stay server-side and override
          matching environment variables.
        </p>
        <Button variant="secondary" size="sm" onClick={load} loading={loading}>
          <RefreshCw className="h-3.5 w-3.5" />
          Re-probe
        </Button>
      </div>

      {!data.canEdit && (
        <Card className="px-4 py-3 text-[13px] text-muted">
          You need the Admin or Owner role to change API connections.
        </Card>
      )}

      {error && (
        <Card className="border-danger/30 px-4 py-3 text-[13px] text-danger">
          {error}
        </Card>
      )}

      {grouped.map((group) => (
        <section key={group.category} className="space-y-3">
          <h2 className="text-sm font-semibold text-fg">{group.category}</h2>
          {group.connections.map((connection) => {
            const draft = drafts[connection.id] ?? {
              enabled: connection.enabled,
              values: {},
            }
            const disabled = !data.canEdit || saving === connection.id
            return (
              <Card key={connection.id}>
                <CardHeader
                  title={
                    <span className="flex flex-wrap items-center gap-2">
                      <KeyRound className="h-4 w-4 text-subtle" />
                      {connection.label}
                      <StatusBadge state={connection.status.state} />
                      <SourceBadge source={connection.source} />
                    </span>
                  }
                  description={connection.description}
                  actions={
                    <label className="flex items-center gap-2 text-2xs font-medium text-muted">
                      <Checkbox
                        checked={draft.enabled}
                        disabled={disabled}
                        onChange={(event) =>
                          updateDraft(connection.id, { enabled: event.target.checked })
                        }
                      />
                      Enabled
                    </label>
                  }
                />

                <div className="space-y-4 px-5 py-4">
                  <div
                    className={cn(
                      'rounded-lg border px-3 py-2.5 text-2xs leading-4',
                      connection.status.state === 'CONNECTED'
                        ? 'border-ok/20 bg-ok/10 text-ok'
                        : connection.status.state === 'ERROR'
                          ? 'border-danger/25 bg-danger/10 text-danger'
                          : 'border-border bg-surface-2 text-muted',
                    )}
                  >
                    {connection.decryptionError ?? connection.status.detail}
                  </div>

                  {connection.quota && <QuotaPanel quota={connection.quota} />}

                  <div className="grid gap-4 sm:grid-cols-2">
                    {connection.fields.map((field) => (
                      <ConnectionField
                        key={field.key}
                        id={`${connection.id}-${field.key}`}
                        field={field}
                        value={draft.values[field.key] ?? ''}
                        disabled={disabled || !draft.enabled}
                        onChange={(value) => setValue(connection.id, field.key, value)}
                      />
                    ))}
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-3">
                  <div className="text-2xs text-subtle">
                    {connection.updatedAt
                      ? `Workspace override saved ${new Date(connection.updatedAt).toLocaleString()}`
                      : 'No workspace override saved'}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={disabled || !connection.hasWorkspaceRecord}
                      onClick={() => remove(connection)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Remove override
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={disabled}
                      loading={saving === connection.id}
                      onClick={() => save(connection)}
                    >
                      {saved === connection.id ? (
                        <Check className="h-3.5 w-3.5" />
                      ) : (
                        <Save className="h-3.5 w-3.5" />
                      )}
                      {saved === connection.id ? 'Saved' : 'Save'}
                    </Button>
                  </div>
                </div>
              </Card>
            )
          })}
        </section>
      ))}
    </div>
  )
}

function QuotaPanel({ quota }: { quota: Quota }) {
  const hasLocalLimit = quota.configuredLimit > 0
  const percent = hasLocalLimit
    ? Math.min(100, Math.round((quota.localUsed / Math.max(1, quota.configuredLimit)) * 100))
    : 0

  return (
    <div
      className={cn(
        'rounded-lg border px-3 py-2.5',
        quota.full ? 'border-danger/25 bg-danger/10' : 'border-border bg-surface-2',
      )}
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="text-2xs font-semibold uppercase tracking-wide text-subtle">
          SerpApi monthly usage
        </div>
        <Badge tone={quota.full ? 'danger' : 'outline'}>
          {quota.full ? 'limit reached' : 'available'}
        </Badge>
      </div>
      {hasLocalLimit && (
        <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-border">
          <div
            className={cn('h-full rounded-full', quota.full ? 'bg-danger' : 'bg-accent')}
            style={{ width: `${percent}%` }}
          />
        </div>
      )}
      <dl className="grid gap-2 text-2xs sm:grid-cols-3">
        <QuotaStat
          label="Local count"
          value={
            hasLocalLimit
              ? `${formatNumber(quota.localUsed)} / ${formatNumber(quota.configuredLimit)}`
              : formatNumber(quota.localUsed)
          }
        />
        <QuotaStat
          label="Local left"
          value={quota.localLeft === null ? 'uncapped' : formatNumber(quota.localLeft)}
        />
        <QuotaStat
          label="SerpApi left"
          value={quota.remoteLeft === null ? 'unknown' : formatNumber(quota.remoteLeft)}
        />
      </dl>
      {(quota.renewalDate || quota.remoteError) && (
        <p className="mt-2 text-2xs leading-4 text-subtle">
          {quota.renewalDate ? `Renews ${quota.renewalDate}. ` : ''}
          {quota.remoteError ? `Account check: ${quota.remoteError}` : ''}
        </p>
      )}
    </div>
  )
}

function QuotaStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-subtle">{label}</dt>
      <dd className="tnum mt-0.5 font-semibold text-fg">{value}</dd>
    </div>
  )
}

function initialDrafts(connections: Connection[]): Record<string, Draft> {
  return Object.fromEntries(
    connections.map((connection) => [
      connection.id,
      {
        enabled: connection.enabled,
        values: Object.fromEntries(
          connection.fields.map((field) => [
            field.key,
            field.type === 'secret' ? '' : field.value ?? field.defaultValue ?? '',
          ]),
        ),
      },
    ]),
  )
}

function ConnectionField({
  id,
  field,
  value,
  disabled,
  onChange,
}: {
  id: string
  field: Field
  value: string
  disabled: boolean
  onChange: (value: string) => void
}) {
  const label = (
    <span className="flex items-center gap-2">
      {field.label}
      {field.required && <Badge tone="outline">required</Badge>}
      {field.type === 'secret' && field.hasValue && (
        <Badge tone={field.source === 'workspace' ? 'accent' : 'neutral'}>
          {sourceLabel(field.source)}
        </Badge>
      )}
    </span>
  )

  if (field.type === 'select') {
    return (
      <div>
        <Label htmlFor={id}>{label}</Label>
        <Select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
          {field.options?.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
        <FieldMeta field={field} />
      </div>
    )
  }

  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        {field.type === 'secret' && (
          <EyeOff className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
        )}
        <Input
          id={id}
          type={field.type === 'secret' ? 'password' : 'text'}
          value={value}
          disabled={disabled}
          placeholder={secretPlaceholder(field)}
          onChange={(e) => onChange(e.target.value)}
          className={field.type === 'secret' ? 'pl-8' : undefined}
          autoComplete="off"
        />
      </div>
      <FieldMeta field={field} />
    </div>
  )
}

function FieldMeta({ field }: { field: Field }) {
  return (
    <p className="mt-1 text-2xs leading-4 text-subtle">
      {field.description ??
        (field.type === 'secret' && field.hasValue
          ? 'Leave blank to keep the current server-side value.'
          : field.source === 'environment'
            ? 'Currently using an environment fallback.'
            : '\u00a0')}
    </p>
  )
}

function secretPlaceholder(field: Field): string | undefined {
  if (field.type !== 'secret') return field.placeholder
  if (field.hasValue) return 'Stored value present'
  return field.placeholder
}

function StatusBadge({ state }: { state: StatusState }) {
  if (state === 'CONNECTED') {
    return (
      <Badge tone="ok">
        <CheckCircle2 className="h-3 w-3" />
        Connected
      </Badge>
    )
  }
  if (state === 'ERROR') {
    return (
      <Badge tone="danger">
        <XCircle className="h-3 w-3" />
        Error
      </Badge>
    )
  }
  return (
    <Badge tone="neutral">
      <MinusCircle className="h-3 w-3" />
      Not configured
    </Badge>
  )
}

function SourceBadge({ source }: { source: ConnectionSource }) {
  const tone =
    source === 'workspace' || source === 'mixed'
      ? 'accent'
      : source === 'disabled'
        ? 'warn'
        : 'outline'
  return <Badge tone={tone}>{sourceLabel(source)}</Badge>
}

function sourceLabel(source: ConnectionSource | Source): string {
  if (source === 'workspace') return 'workspace'
  if (source === 'environment') return 'env fallback'
  if (source === 'mixed') return 'workspace + env'
  if (source === 'disabled') return 'disabled'
  return 'not set'
}
