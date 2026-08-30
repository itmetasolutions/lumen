'use client'

import { useId } from 'react'
import { cn, formatNumber } from '@/lib/utils'

/**
 * Hand-rolled SVG charts.
 *
 * No charting dependency: these are four simple, static shapes and a library
 * would add far more surface area (and bundle weight) than it saves. Everything
 * here is theme-aware through CSS variables and degrades to an honest empty
 * state rather than rendering an axis with no data behind it.
 */

const PALETTE = [
  'hsl(var(--accent))',
  'hsl(var(--info))',
  'hsl(var(--ok))',
  'hsl(var(--warn))',
  'hsl(var(--danger))',
  'hsl(var(--subtle))',
]

export interface Datum {
  label: string
  value: number
  color?: string
}

function NoData({ message = 'No data yet' }: { message?: string }) {
  return (
    <div className="flex h-full min-h-[140px] items-center justify-center text-[13px] text-subtle">
      {message}
    </div>
  )
}

// ── Horizontal bars — best for ranked categorical comparisons ────────────────

export function BarList({
  data,
  max: providedMax,
  valueFormat = formatNumber,
  emptyMessage,
}: {
  data: Datum[]
  max?: number
  valueFormat?: (n: number) => string
  emptyMessage?: string
}) {
  if (data.length === 0) return <NoData message={emptyMessage} />
  const max = providedMax ?? Math.max(...data.map((d) => d.value), 1)

  return (
    <ul className="space-y-2">
      {data.map((d, i) => (
        <li key={d.label}>
          <div className="mb-1 flex items-baseline justify-between gap-3 text-[13px]">
            <span className="truncate text-muted">{d.label}</span>
            <span className="tnum shrink-0 font-medium">{valueFormat(d.value)}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
            <div
              className="h-full rounded-full transition-[width] duration-500"
              style={{
                width: `${Math.max(1.5, (d.value / max) * 100)}%`,
                background: d.color ?? PALETTE[i % PALETTE.length],
              }}
            />
          </div>
        </li>
      ))}
    </ul>
  )
}

// ── Donut — part-to-whole across a handful of categories ─────────────────────

export function Donut({
  data,
  size = 148,
  thickness = 18,
  centerLabel,
  centerValue,
}: {
  data: Datum[]
  size?: number
  thickness?: number
  centerLabel?: string
  centerValue?: string
}) {
  const total = data.reduce((sum, d) => sum + d.value, 0)
  if (total === 0) return <NoData />

  const radius = (size - thickness) / 2
  const circumference = 2 * Math.PI * radius
  let offset = 0

  return (
    <div className="flex items-center gap-5">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          {data.map((d, i) => {
            const fraction = d.value / total
            const dash = fraction * circumference
            const el = (
              <circle
                key={d.label}
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                stroke={d.color ?? PALETTE[i % PALETTE.length]}
                strokeWidth={thickness}
                strokeDasharray={`${dash} ${circumference - dash}`}
                strokeDashoffset={-offset}
              />
            )
            offset += dash
            return el
          })}
        </g>
        {(centerValue || centerLabel) && (
          <>
            <text
              x="50%"
              y="47%"
              textAnchor="middle"
              className="fill-fg text-[20px] font-semibold"
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {centerValue}
            </text>
            <text x="50%" y="62%" textAnchor="middle" className="fill-subtle text-[10px]">
              {centerLabel}
            </text>
          </>
        )}
      </svg>

      <ul className="min-w-0 flex-1 space-y-1.5">
        {data.map((d, i) => (
          <li key={d.label} className="flex items-center gap-2 text-[13px]">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ background: d.color ?? PALETTE[i % PALETTE.length] }}
            />
            <span className="min-w-0 flex-1 truncate text-muted">{d.label}</span>
            <span className="tnum font-medium">{formatNumber(d.value)}</span>
            <span className="tnum w-9 text-right text-2xs text-subtle">
              {Math.round((d.value / total) * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ── Histogram — score distributions, coloured by band ────────────────────────

export function Histogram({
  buckets,
  height = 120,
  invertColor = false,
}: {
  buckets: Array<{ label: string; value: number; from: number }>
  height?: number
  invertColor?: boolean
}) {
  const max = Math.max(...buckets.map((b) => b.value), 1)
  if (buckets.every((b) => b.value === 0)) {
    return <NoData message="No scored businesses yet" />
  }

  return (
    <div>
      <div className="flex items-end gap-1.5" style={{ height }}>
        {buckets.map((b) => {
          const score = invertColor ? 100 - b.from : b.from
          const color =
            score >= 80 ? 'hsl(var(--ok))'
            : score >= 50 ? 'hsl(var(--warn))'
            : 'hsl(var(--danger))'
          return (
            <div key={b.label} className="group/bar flex flex-1 flex-col items-center gap-1">
              <span className="tnum text-2xs text-subtle opacity-0 transition-opacity group-hover/bar:opacity-100">
                {formatNumber(b.value)}
              </span>
              <div
                className="w-full rounded-t transition-[height] duration-500"
                style={{
                  height: `${Math.max(2, (b.value / max) * (height - 20))}px`,
                  background: color,
                  opacity: 0.85,
                }}
                title={`${b.label}: ${formatNumber(b.value)}`}
              />
            </div>
          )
        })}
      </div>
      <div className="mt-1.5 flex gap-1.5">
        {buckets.map((b) => (
          <div key={b.label} className="flex-1 text-center text-2xs text-subtle">
            {b.label}
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Line — a trend over time ─────────────────────────────────────────────────

export function LineChart({
  points,
  height = 140,
  className,
}: {
  points: Array<{ label: string; value: number }>
  height?: number
  className?: string
}) {
  const gradientId = useId()
  if (points.length < 2) return <NoData message="Not enough history yet" />

  const width = 600
  const pad = { top: 8, right: 4, bottom: 18, left: 28 }
  const max = Math.max(...points.map((p) => p.value), 1)
  const innerW = width - pad.left - pad.right
  const innerH = height - pad.top - pad.bottom

  const x = (i: number) => pad.left + (i / (points.length - 1)) * innerW
  const y = (v: number) => pad.top + innerH - (v / max) * innerH

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(p.value)}`).join(' ')
  const area = `${line} L ${x(points.length - 1)} ${pad.top + innerH} L ${x(0)} ${pad.top + innerH} Z`

  const ticks = [0, Math.round(max / 2), max]

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className={cn('w-full', className)}
      preserveAspectRatio="none"
      role="img"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="hsl(var(--accent))" stopOpacity="0.22" />
          <stop offset="100%" stopColor="hsl(var(--accent))" stopOpacity="0" />
        </linearGradient>
      </defs>

      {ticks.map((t) => (
        <g key={t}>
          <line
            x1={pad.left}
            x2={width - pad.right}
            y1={y(t)}
            y2={y(t)}
            stroke="hsl(var(--border))"
            strokeDasharray="3 3"
          />
          <text
            x={pad.left - 5}
            y={y(t) + 3}
            textAnchor="end"
            className="fill-subtle"
            style={{ fontSize: 8 }}
          >
            {t}
          </text>
        </g>
      ))}

      <path d={area} fill={`url(#${gradientId})`} />
      <path
        d={line}
        fill="none"
        stroke="hsl(var(--accent))"
        strokeWidth="1.75"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />

      {points.map((p, i) =>
        // Label only the ends and the middle; a 30-point axis is unreadable.
        i === 0 || i === points.length - 1 || i === Math.floor(points.length / 2) ? (
          <text
            key={p.label}
            x={x(i)}
            y={height - 5}
            textAnchor={i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}
            className="fill-subtle"
            style={{ fontSize: 8 }}
          >
            {p.label}
          </text>
        ) : null,
      )}
    </svg>
  )
}
