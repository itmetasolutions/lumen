import { requireAuth } from '@/server/auth/guard'
import { prisma } from '@/server/db/client'
import { Card, EmptyState } from '@/components/ui/primitives'
import { BusinessMap } from '@/components/map/business-map'
import { MapPin } from 'lucide-react'

export const metadata = { title: 'Map' }
export const dynamic = 'force-dynamic'

/**
 * §24 — optional map view. The table remains the primary interface, so this is
 * capped at a sane number of markers rather than trying to plot 100k rows.
 */
export default async function MapPage() {
  const auth = await requireAuth()

  const businesses = await prisma.business.findMany({
    where: {
      workspaceId: auth.workspaceId,
      latitude: { not: null },
      longitude: { not: null },
    },
    select: {
      id: true,
      name: true,
      latitude: true,
      longitude: true,
      city: true,
      leadScore: true,
      leadTier: true,
      rating: true,
      reviewCount: true,
      websiteDomain: true,
      primaryPhone: true,
      needsWebsite: true,
      needsRedesign: true,
      needsSeo: true,
      needsSpeed: true,
      isDemo: true,
    },
    orderBy: { leadScore: 'desc' },
    take: 3000,
  })

  const total = await prisma.business.count({ where: { workspaceId: auth.workspaceId } })

  if (businesses.length === 0) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-16">
        <Card>
          <EmptyState
            icon={<MapPin className="h-5 w-5" />}
            title="Nothing to plot yet"
            description={
              total > 0
                ? 'None of your businesses have coordinates. Google Places and OpenStreetMap both supply them; a CSV import may not.'
                : 'Run a discovery first — businesses appear here once they have coordinates.'
            }
          />
        </Card>
      </div>
    )
  }

  return (
    <div className="h-full px-6 py-6">
      <BusinessMap
        businesses={businesses.map((b) => ({
          ...b,
          latitude: b.latitude!,
          longitude: b.longitude!,
        }))}
        totalBusinesses={total}
      />
    </div>
  )
}
