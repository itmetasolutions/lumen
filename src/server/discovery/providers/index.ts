import 'server-only'
import type { DiscoveryProvider, ProviderStatus } from '../types'
import { GooglePlacesProvider } from './google-places'
import { OpenStreetMapProvider } from './openstreetmap'
import { SearchProvider, SerpApiYelpProvider, SerpApiYandexProvider } from './search'

/**
 * The provider registry (§5, §21).
 *
 * Order matters only for display. Adding a source = one import + one entry.
 * Nothing else in the codebase enumerates providers.
 */
const REGISTRY: DiscoveryProvider[] = [
  new GooglePlacesProvider(),
  new OpenStreetMapProvider(),
  new SearchProvider(),
  new SerpApiYelpProvider(),
  new SerpApiYandexProvider(),
]

export function allProviders(): DiscoveryProvider[] {
  return REGISTRY
}

export function getProvider(id: string): DiscoveryProvider | undefined {
  return REGISTRY.find((p) => p.id === id)
}

export interface ProviderInfo {
  id: string
  label: string
  description: string
  isDemo: boolean
  termsUrl?: string
  status: ProviderStatus
  capabilities: ReturnType<DiscoveryProvider['capabilities']>
}

/**
 * Live status for Settings → Integrations and the discovery wizard.
 * Probes run in parallel and a probe failure becomes an ERROR status rather
 * than an exception — one unreachable provider must not blank the page.
 */
export async function providerStatuses(workspaceId?: string): Promise<ProviderInfo[]> {
  return Promise.all(
    REGISTRY.map(async (p) => {
      let status: ProviderStatus
      try {
        status = await p.configured(workspaceId)
      } catch (err) {
        status = { state: 'ERROR', detail: (err as Error).message }
      }
      return {
        id: p.id,
        label: p.label,
        description: p.description,
        isDemo: p.isDemo,
        termsUrl: p.termsUrl,
        status,
        capabilities: p.capabilities(),
      }
    }),
  )
}
