import 'server-only'
import { env } from '@/server/env'
import type { JobQueue } from './types'
import { PgQueue } from './pg-queue'

let instance: JobQueue | null = null

/**
 * The only way application code obtains a queue. Nothing outside this module
 * imports PgQueue or BullMQQueue directly (§17 — providers are replaceable).
 */
export function getQueue(): JobQueue {
  if (instance) return instance
  if (env.queueDriver === 'bullmq') {
    // Loaded lazily so a Redis-less install never touches ioredis.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { BullMQQueue } = require('./bullmq-queue') as typeof import('./bullmq-queue')
    instance = new BullMQQueue()
  } else {
    instance = new PgQueue()
  }
  return instance
}

export * from './types'
