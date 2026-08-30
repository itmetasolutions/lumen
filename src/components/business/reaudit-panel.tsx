'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { RefreshCw, Check } from 'lucide-react'
import { Button, Checkbox, Modal, Select } from '@/components/ui/primitives'

/**
 * §26 — re-audit controls.
 *
 * Scope selection exists because re-running everything to re-check one thing is
 * wasteful: after a client says "we fixed the speed", only the performance stage
 * needs to run. Manual runs also bypass the performance cache by design.
 */

const SCOPES = [
  { id: 'seo', label: 'SEO', detail: 'Titles, meta, headings, schema, indexability' },
  { id: 'performance', label: 'Speed', detail: 'PageSpeed mobile + desktop (bypasses cache)' },
  { id: 'ux', label: 'UX / UI', detail: 'Browser rendering, layout, screenshots' },
  { id: 'technical', label: 'Technical', detail: 'Status codes, links, HTTPS, assets' },
] as const

export function ReauditPanel({
  businessId,
  hasWebsite,
}: {
  businessId: string
  hasWebsite: boolean
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [scopes, setScopes] = useState<string[]>(['seo', 'performance', 'ux', 'technical'])
  const [depth, setDepth] = useState<'QUICK' | 'STANDARD' | 'DEEP'>('STANDARD')
  const [state, setState] = useState<'idle' | 'saving' | 'queued' | 'error'>('idle')
  const [message, setMessage] = useState<string | null>(null)

  async function submit() {
    setState('saving')
    try {
      const res = await fetch(`/api/businesses/${businessId}/reaudit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scopes, depth }),
      })
      const json = await res.json()
      if (!res.ok) {
        setState('error')
        setMessage(json.error ?? 'Could not queue the audit')
        return
      }
      setState('queued')
      setMessage(
        'Audit queued. The worker will pick it up — refresh in a minute to see the new results alongside the old ones.',
      )
      router.refresh()
    } catch {
      setState('error')
      setMessage('Could not reach the server')
    }
  }

  if (!hasWebsite) return null

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <RefreshCw className="h-3.5 w-3.5" />
        Re-audit
      </Button>

      <Modal
        open={open}
        onClose={() => {
          setOpen(false)
          setState('idle')
          setMessage(null)
        }}
        title="Re-audit this website"
        description="A new audit is created. Previous audits are kept so you can compare over time."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Close
            </Button>
            <Button
              variant="primary"
              onClick={submit}
              loading={state === 'saving'}
              disabled={scopes.length === 0 || state === 'queued'}
            >
              Queue audit
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <div className="mb-2 text-2xs font-semibold uppercase tracking-wide text-subtle">
              Which checks
            </div>
            <div className="space-y-1.5">
              {SCOPES.map((s) => (
                <label
                  key={s.id}
                  className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border p-2.5 hover:bg-surface-2"
                >
                  <Checkbox
                    className="mt-0.5"
                    checked={scopes.includes(s.id)}
                    onChange={() =>
                      setScopes((prev) =>
                        prev.includes(s.id) ? prev.filter((x) => x !== s.id) : [...prev, s.id],
                      )
                    }
                  />
                  <span>
                    <span className="block text-[13px] font-medium">{s.label}</span>
                    <span className="block text-2xs text-muted">{s.detail}</span>
                  </span>
                </label>
              ))}
            </div>
            <p className="mt-2 text-2xs text-subtle">
              The site is re-crawled automatically whenever SEO, UX or technical checks
              are selected — they all read the crawled pages.
            </p>
          </div>

          <div>
            <div className="mb-1.5 text-2xs font-semibold uppercase tracking-wide text-subtle">
              Depth
            </div>
            <Select value={depth} onChange={(e) => setDepth(e.target.value as never)}>
              <option value="QUICK">Quick — homepage only, no browser rendering</option>
              <option value="STANDARD">Standard — key pages, screenshots, full checks</option>
              <option value="DEEP">Deep — wider crawl, more links verified</option>
            </Select>
          </div>

          {message && (
            <div
              className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 text-[13px] ${
                state === 'error'
                  ? 'border-danger/25 bg-danger/10 text-danger'
                  : 'border-ok/25 bg-ok/10 text-ok'
              }`}
            >
              {state === 'queued' && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
              {message}
            </div>
          )}
        </div>
      </Modal>
    </>
  )
}
