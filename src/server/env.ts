import 'server-only'

/**
 * Single server-side gateway to configuration.
 *
 * §20/§29: secrets are read here and here only. Nothing in this module may be
 * imported from a client component — the `server-only` guard makes that a build
 * error rather than a silent leak.
 */

function str(key: string, fallback?: string): string | undefined {
  const v = process.env[key]
  if (v === undefined || v.trim() === '') return fallback
  return v.trim()
}

function int(key: string, fallback: number): number {
  const v = process.env[key]
  if (!v) return fallback
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) ? n : fallback
}

export const env = {
  databaseUrl: str('DATABASE_URL') ?? '',
  authSecret: str('AUTH_SECRET') ?? 'dev-insecure-secret-change-me',
  nodeEnv: str('NODE_ENV', 'development')!,

  queueDriver: (str('QUEUE_DRIVER', 'pg') as 'pg' | 'bullmq') ?? 'pg',
  redisUrl: str('REDIS_URL'),

  googleMapsApiKey: str('GOOGLE_MAPS_API_KEY'),
  pagespeedApiKey: str('GOOGLE_PAGESPEED_API_KEY'),
  searchProviderApiKey: str('SEARCH_PROVIDER_API_KEY'),
  searchProviderKind: str('SEARCH_PROVIDER_KIND', 'serpapi')!,
  yelpFusionApiKey: str('YELP_FUSION_API_KEY'),
  overpassEndpoint: str('OVERPASS_ENDPOINT', 'https://overpass-api.de/api/interpreter')!,

  openaiApiKey: str('OPENAI_API_KEY'),
  openaiVisionModel: str('OPENAI_VISION_MODEL', 'gpt-4o-mini')!,

  s3Endpoint: str('S3_ENDPOINT'),
  s3AccessKey: str('S3_ACCESS_KEY'),
  s3SecretKey: str('S3_SECRET_KEY'),
  s3Bucket: str('S3_BUCKET'),
  storageDir: str('STORAGE_DIR', '.data/storage')!,

  playwrightChannel: str('PLAYWRIGHT_CHANNEL', 'msedge')!,
  crawlerUserAgent: str(
    'CRAWLER_USER_AGENT',
    'LumenAuditBot/0.1 (+website audit)',
  )!,
  crawlerContact: str('CRAWLER_CONTACT'),

  maxBusinessesPerDiscovery: int('MAX_BUSINESSES_PER_DISCOVERY', 500),
  maxPagesQuick: int('MAX_PAGES_PER_SITE_QUICK', 1),
  maxPagesStandard: int('MAX_PAGES_PER_SITE_STANDARD', 8),
  maxPagesDeep: int('MAX_PAGES_PER_SITE_DEEP', 40),
  concurrencyDiscovery: int('WORKER_CONCURRENCY_DISCOVERY', 2),
  concurrencyAudit: int('WORKER_CONCURRENCY_AUDIT', 4),
} as const

export function isProd() {
  return env.nodeEnv === 'production'
}
