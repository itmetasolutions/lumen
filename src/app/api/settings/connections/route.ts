import { z } from 'zod'
import { NextResponse } from 'next/server'
import { prisma } from '@/server/db/client'
import { requireRole } from '@/server/auth/guard'
import { route, HttpError } from '@/app/api/_lib/handler'
import { providerStatuses } from '@/server/discovery/providers'
import { getSerpApiQuotaStatus } from '@/server/discovery/providers/search'
import { performanceProviders } from '@/server/audit/performance'
import { openAIConnectionStatus } from '@/server/ai'
import { s3ConnectionStatus } from '@/server/settings/connections'
import {
  deleteConnection,
  getConnectionSummaries,
  isConnectionProviderId,
  saveConnection,
  type ConnectionProviderId,
} from '@/server/settings/connections'

const saveSchema = z.object({
  provider: z.string(),
  enabled: z.boolean().default(true),
  values: z.record(z.string().max(2000)).default({}),
})

export const GET = route({ limit: 'expensive' }, async ({ auth }) => {
  const [connections, statuses, serpApiQuota] = await Promise.all([
    getConnectionSummaries(auth.workspaceId),
    probeConnections(auth.workspaceId),
    getSerpApiQuotaStatus(auth.workspaceId),
  ])

  return {
    canEdit: auth.role === 'ADMIN' || auth.role === 'OWNER',
    connections: connections.map((connection) => ({
      ...connection,
      status: statuses[connection.id],
      quota: connection.id === 'search' ? serpApiQuota : null,
    })),
  }
})

export const PUT = route({ schema: saveSchema, limit: 'write' }, async ({ auth, body }) => {
  requireRole(auth, 'ADMIN')
  const provider = parseProvider(body.provider)

  await saveConnection({
    workspaceId: auth.workspaceId,
    provider,
    enabled: body.enabled,
    values: body.values,
  })

  await prisma.auditLog.create({
    data: {
      workspaceId: auth.workspaceId,
      userId: auth.userId,
      action: 'settings.connection.save',
      target: provider,
      meta: { enabled: body.enabled },
    },
  })

  return { ok: true }
})

export const DELETE = route({ limit: 'write' }, async ({ auth, req }) => {
  requireRole(auth, 'ADMIN')
  const provider = parseProvider(new URL(req.url).searchParams.get('provider') ?? '')

  await deleteConnection(auth.workspaceId, provider)

  await prisma.auditLog.create({
    data: {
      workspaceId: auth.workspaceId,
      userId: auth.userId,
      action: 'settings.connection.delete',
      target: provider,
    },
  })

  return NextResponse.json({ ok: true })
})

async function probeConnections(workspaceId: string): Promise<
  Record<ConnectionProviderId, { state: 'CONNECTED' | 'NOT_CONFIGURED' | 'ERROR'; detail: string }>
> {
  const discovery = await providerStatuses(workspaceId)
  const performance = await Promise.all(
    performanceProviders().map(async (provider) => {
      try {
        return { id: provider.id, status: await provider.configured(workspaceId) }
      } catch (err) {
        return {
          id: provider.id,
          status: { state: 'ERROR' as const, detail: (err as Error).message },
        }
      }
    }),
  )
  const ai = await openAIConnectionStatus(workspaceId)
  const s3 = await s3ConnectionStatus(workspaceId)

  const google = discovery.find((p) => p.id === 'google-places')?.status ?? {
    state: 'NOT_CONFIGURED' as const,
    detail: 'Google Places provider is not registered.',
  }
  const search = discovery.find((p) => p.id === 'search')?.status ?? {
    state: 'NOT_CONFIGURED' as const,
    detail: 'SerpApi search provider is not registered.',
  }
  const yelpFusion = discovery.find((p) => p.id === 'yelp-fusion')?.status ?? {
    state: 'NOT_CONFIGURED' as const,
    detail: 'Yelp Fusion provider is not registered.',
  }
  const pagespeed = performance.find((p) => p.id === 'pagespeed')?.status ?? {
    state: 'NOT_CONFIGURED' as const,
    detail: 'PageSpeed provider is not registered.',
  }

  return {
    'google-places': google,
    search,
    'yelp-fusion': yelpFusion,
    pagespeed,
    openai: { state: ai.state, detail: ai.detail },
    s3,
  }
}

function parseProvider(value: string): ConnectionProviderId {
  if (!isConnectionProviderId(value)) {
    throw new HttpError(400, 'Unknown connection provider')
  }
  return value
}
