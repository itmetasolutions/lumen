'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { KeyRound, Plug, Scale, SlidersHorizontal, Building2, PhoneCall, UserCog } from 'lucide-react'
import { cn } from '@/lib/utils'

const ITEMS = [
  { href: '/settings/connections', label: 'Connections', icon: KeyRound },
  { href: '/settings/integrations', label: 'Integrations', icon: Plug },
  { href: '/settings/scoring', label: 'Scoring', icon: Scale },
  { href: '/settings/audit-rules', label: 'Audit rules', icon: SlidersHorizontal },
  { href: '/settings/calling', label: 'Calling', icon: PhoneCall },
  { href: '/settings/workspace', label: 'Workspace', icon: Building2 },
  { href: '/settings/profile', label: 'My profile', icon: UserCog },
]

export function SettingsNav() {
  const pathname = usePathname()

  return (
    <nav>
      <ul className="space-y-0.5">
        {ITEMS.map((item) => {
          const active = pathname === item.href
          const Icon = item.icon
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                className={cn(
                  'flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] transition-colors',
                  active
                    ? 'bg-accent-soft font-semibold text-accent'
                    : 'text-muted hover:bg-surface-2 hover:text-fg',
                )}
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
