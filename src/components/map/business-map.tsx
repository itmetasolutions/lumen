'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { ExternalLink, Phone, X } from 'lucide-react'
import { Badge, Button, Card, ScorePill } from '@/components/ui/primitives'
import { cn, formatNumber } from '@/lib/utils'

/**
 * Spatial distribution view (§24).
 *
 * A dependency-free plot rather than a tiled street map: it renders entirely
 * offline, makes no third-party requests, and answers the question the brief
 * actually asks of it — where are the opportunities clustered, and let me open
 * one. The table stays the primary interface, as specified.
 *
 * Swapping in a tile layer later is a contained change: the projection below is
 * standard Web Mercator, so tile coordinates line up.
 */

interface MapBusiness {
  id: string
  name: string
  latitude: number
  longitude: number
  city: string | null
  leadScore: number | null
  leadTier: string | null
  rating: number | null
  reviewCount: number | null
  websiteDomain: string | null
  primaryPhone: string | null
  needsWebsite: boolean
  needsRedesign: boolean
  needsSeo: boolean
  needsSpeed: boolean
  isDemo: boolean
}

type FilterId = 'all' | 'website' | 'redesign' | 'seo' | 'speed' | 'hot'

const FILTERS: Array<{ id: FilterId; label: string; test: (b: MapBusiness) => boolean; color: string }> = [
  { id: 'all', label: 'All', test: () => true, color: 'hsl(var(--subtle))' },
  { id: 'website', label: 'No website', test: (b) => b.needsWebsite, color: 'hsl(var(--danger))' },
  { id: 'redesign', label: 'Redesign', test: (b) => b.needsRedesign, color: 'hsl(var(--warn))' },
  { id: 'seo', label: 'SEO', test: (b) => b.needsSeo, color: 'hsl(var(--info))' },
  { id: 'speed', label: 'Speed', test: (b) => b.needsSpeed, color: 'hsl(var(--accent))' },
  { id: 'hot', label: 'Hot leads', test: (b) => b.leadTier === 'HOT', color: 'hsl(var(--danger))' },
]

/** Web Mercator, normalised to 0..1. */
function project(lat: number, lng: number) {
  const x = (lng + 180) / 360
  const clamped = Math.max(-85.05, Math.min(85.05, lat))
  const rad = (clamped * Math.PI) / 180
  const y = 0.5 - Math.log(Math.tan(Math.PI / 4 + rad / 2)) / (2 * Math.PI)
  return { x, y }
}

export function BusinessMap({
  businesses,
  totalBusinesses,
}: {
  businesses: MapBusiness[]
  totalBusinesses: number
}) {
  const [filter, setFilter] = useState<FilterId>('all')
  const [selected, setSelected] = useState<MapBusiness | null>(null)

  const active = FILTERS.find((f) => f.id === filter)!
  const visible = useMemo(
    () => businesses.filter(active.test),
    [businesses, active],
  )

  const bounds = useMemo(() => {
    if (visible.length === 0) return null
    const pts = visible.map((b) => project(b.latitude, b.longitude))
    const minX = Math.min(...pts.map((p) => p.x))
    const maxX = Math.max(...pts.map((p) => p.x))
    const minY = Math.min(...pts.map((p) => p.y))
    const maxY = Math.max(...pts.map((p) => p.y))
    // Pad so markers at the extremes are not clipped by the viewport edge.
    const padX = Math.max((maxX - minX) * 0.08, 0.0004)
    const padY = Math.max((maxY - minY) * 0.08, 0.0004)
    return {
      minX: minX - padX,
      maxX: maxX + padX,
      minY: minY - padY,
      maxY: maxY + padY,
    }
  }, [visible])

  const W = 1000
  const H = 620

  function toScreen(b: MapBusiness) {
    if (!bounds) return { cx: W / 2, cy: H / 2 }
    const p = project(b.latitude, b.longitude)
    const spanX = bounds.maxX - bounds.minX || 1
    const spanY = bounds.maxY - bounds.minY || 1
    // Preserve aspect ratio so the geography is not stretched.
    const scale = Math.min(W / spanX, H / spanY)
    const offsetX = (W - spanX * scale) / 2
    const offsetY = (H - spanY * scale) / 2
    return {
      cx: (p.x - bounds.minX) * scale + offsetX,
      cy: (p.y - bounds.minY) * scale + offsetY,
    }
  }

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Spatial distribution</h1>
          <p className="mt-1 text-[13px] text-muted">
            {formatNumber(visible.length)} of {formatNumber(businesses.length)} geocoded
            businesses
            {businesses.length < totalBusinesses && (
              <> · {formatNumber(totalBusinesses - businesses.length)} have no coordinates</>
            )}
          </p>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((f) => {
            const count = businesses.filter(f.test).length
            return (
              <button
                key={f.id}
                onClick={() => setFilter(f.id)}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[13px] transition-colors',
                  filter === f.id
                    ? 'border-accent bg-accent-soft font-medium text-accent'
                    : 'border-border text-muted hover:bg-surface-2',
                )}
              >
                <span className="h-2 w-2 rounded-full" style={{ background: f.color }} />
                {f.label}
                <span className="tnum text-2xs text-subtle">{formatNumber(count)}</span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        <Card className="h-full overflow-hidden">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="h-full w-full bg-surface-2"
            role="img"
            aria-label="Business locations"
          >
            <defs>
              <pattern id="grid" width="50" height="50" patternUnits="userSpaceOnUse">
                <path
                  d="M 50 0 L 0 0 0 50"
                  fill="none"
                  stroke="hsl(var(--border))"
                  strokeWidth="0.5"
                />
              </pattern>
            </defs>
            <rect width={W} height={H} fill="url(#grid)" />

            {visible.map((b) => {
              const { cx, cy } = toScreen(b)
              const isSelected = selected?.id === b.id
              const score = b.leadScore ?? 0
              // Marker size carries lead score so the best prospects stand out.
              const r = 3 + (score / 100) * 5
              return (
                <g key={b.id}>
                  {isSelected && (
                    <circle cx={cx} cy={cy} r={r + 6} fill="hsl(var(--accent))" opacity="0.2" />
                  )}
                  <circle
                    cx={cx}
                    cy={cy}
                    r={r}
                    fill={active.color}
                    fillOpacity={b.isDemo ? 0.35 : 0.7}
                    stroke={isSelected ? 'hsl(var(--accent))' : 'hsl(var(--surface))'}
                    strokeWidth={isSelected ? 2 : 1}
                    className="cursor-pointer transition-all hover:fill-opacity-100"
                    onClick={() => setSelected(b)}
                  >
                    <title>{`${b.name}${b.leadScore !== null ? ` — lead score ${b.leadScore}` : ''}`}</title>
                  </circle>
                </g>
              )
            })}
          </svg>
        </Card>

        {selected && (
          <Card className="absolute bottom-4 left-4 w-80 shadow-pop">
            <div className="flex items-start justify-between gap-2 border-b border-border px-4 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[13px] font-semibold">{selected.name}</span>
                  {selected.isDemo && <Badge tone="demo">DEMO</Badge>}
                </div>
                <div className="text-2xs text-subtle">{selected.city ?? 'Location unknown'}</div>
              </div>
              <button onClick={() => setSelected(null)} aria-label="Close preview">
                <X className="h-3.5 w-3.5 text-subtle hover:text-fg" />
              </button>
            </div>

            <div className="space-y-2.5 px-4 py-3 text-[13px]">
              <div className="flex items-center justify-between">
                <span className="text-muted">Lead score</span>
                <ScorePill score={selected.leadScore} />
              </div>

              {selected.rating !== null && (
                <div className="flex items-center justify-between">
                  <span className="text-muted">Rating</span>
                  <span className="tnum">
                    {selected.rating.toFixed(1)}★ ({formatNumber(selected.reviewCount)})
                  </span>
                </div>
              )}

              <div className="flex flex-wrap gap-1">
                {selected.needsWebsite && <Badge tone="danger">Website</Badge>}
                {selected.needsRedesign && <Badge tone="warn">Redesign</Badge>}
                {selected.needsSeo && <Badge tone="info">SEO</Badge>}
                {selected.needsSpeed && <Badge tone="accent">Speed</Badge>}
              </div>

              {selected.primaryPhone && (
                <a
                  href={`tel:${selected.primaryPhone}`}
                  className="flex items-center gap-1.5 text-muted hover:text-accent"
                >
                  <Phone className="h-3 w-3" />
                  {selected.primaryPhone}
                </a>
              )}

              {selected.websiteDomain && (
                <a
                  href={`https://${selected.websiteDomain}`}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="flex items-center gap-1.5 truncate text-accent hover:underline"
                >
                  <ExternalLink className="h-3 w-3 shrink-0" />
                  {selected.websiteDomain}
                </a>
              )}

              <Link href={`/businesses/${selected.id}`} className="block pt-1">
                <Button variant="primary" size="sm" className="w-full justify-center">
                  Open full profile
                </Button>
              </Link>
            </div>
          </Card>
        )}
      </div>
    </div>
  )
}
