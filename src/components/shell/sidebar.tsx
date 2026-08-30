'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  LayoutDashboard, Search, History, Database, Globe, PaintRoller,
  TrendingUp, Gauge, Flame, Sparkles, FileDown, Bookmark, Settings,
  Map as MapIcon, ClipboardCheck,
} from 'lucide-react'
import { cn, formatNumber } from '@/lib/utils'
import type { TabCounts } from '@/server/leads/query'

/**
 * Primary navigation (§35, §36).
 *
 * Counts sit beside the service tabs because "how many leads are in each
 * bucket" is the question a user opens this product to answer.
 */

interface NavItem {
  href: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  count?: number
  exact?: boolean
}

interface NavSection {
  label: string | null
  items: NavItem[]
}

export function Sidebar({
  counts,
  workspaceName,
}: {
  counts: TabCounts
  workspaceName: string
}) {
  const pathname = usePathname()

  const sections: NavSection[] = [
    {
      label: null,
      items: [{ href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard }],
    },
    {
      label: 'Discovery',
      items: [
        { href: '/discovery/new', label: 'New Discovery', icon: Search },
        { href: '/discovery/jobs', label: 'Discovery Jobs', icon: History },
      ],
    },
    {
      label: 'Leads',
      items: [
        { href: '/leads/all', label: 'All Businesses', icon: Database, count: counts.all },
        { href: '/leads/website-creation', label: 'Website Creation', icon: Globe, count: counts['website-creation'] },
        { href: '/leads/redesign', label: 'Website Redesign', icon: PaintRoller, count: counts.redesign },
        { href: '/leads/seo', label: 'SEO', icon: TrendingUp, count: counts.seo },
        { href: '/leads/speed', label: 'Speed Optimization', icon: Gauge, count: counts.speed },
        { href: '/leads/hot', label: 'Hot Leads', icon: Flame, count: counts.hot },
        { href: '/leads/new', label: 'New Leads', icon: Sparkles, count: counts.new },
      ],
    },
    {
      label: 'Workspace',
      items: [
        { href: '/map', label: 'Map', icon: MapIcon },
        { href: '/audits', label: 'Recent Audits', icon: ClipboardCheck },
        { href: '/views', label: 'Saved Views', icon: Bookmark },
        { href: '/exports', label: 'Exports', icon: FileDown },
        { href: '/settings/connections', label: 'Settings', icon: Settings },
      ],
    },
  ]

  return (
    <aside className="flex h-full w-[248px] shrink-0 flex-col border-r border-border bg-surface">
      <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-border px-4">
        <span className="text-accent">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.6" opacity="0.5" />
            <circle cx="12" cy="12" r="4" fill="currentColor" />
            <path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </span>
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold leading-4">Lumen</div>
          <div className="truncate text-2xs leading-4 text-subtle">{workspaceName}</div>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-2.5 py-3">
        {sections.map((section, i) => (
          <div key={section.label ?? i} className={cn(i > 0 && 'mt-5')}>
            {section.label && (
              <div className="mb-1.5 px-2.5 text-2xs font-semibold uppercase tracking-wider text-subtle">
                {section.label}
              </div>
            )}
            <ul className="space-y-0.5">
              {section.items.map((item) => {
                const active =
                  pathname === item.href ||
                  (item.href !== '/dashboard' && pathname.startsWith(`${item.href}/`)) ||
                  (item.href.startsWith('/settings') && pathname.startsWith('/settings'))

                const Icon = item.icon
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className={cn(
                        'group flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[13px] transition-colors',
                        active
                          ? 'bg-accent-soft font-semibold text-accent'
                          : 'text-muted hover:bg-surface-2 hover:text-fg',
                      )}
                    >
                      <Icon className={cn('h-4 w-4 shrink-0', active ? 'text-accent' : 'text-subtle group-hover:text-muted')} />
                      <span className="flex-1 truncate">{item.label}</span>
                      {item.count !== undefined && item.count > 0 && (
                        <span
                          className={cn(
                            'tnum rounded px-1.5 py-0.5 text-2xs font-medium',
                            active ? 'bg-accent/15 text-accent' : 'bg-surface-2 text-subtle',
                          )}
                        >
                          {formatNumber(item.count)}
                        </span>
                      )}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </nav>
    </aside>
  )
}
