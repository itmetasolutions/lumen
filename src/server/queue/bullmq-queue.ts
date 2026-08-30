import 'server-only'
import { env } from '@/server/env'
import type {
  EnqueueOptions,
  JobHandler,
  JobName,
  JobPayloads,
  JobQueue,
} from './types'
import { QUEUE_FOR } from './types'

/**
 * BullMQ driver. Selected with QUEUE_DRIVER=bullmq + REDIS_URL.
 *
 * bullmq/ioredis are optionalDependencies: this module only loads them when the
 * driver is actually selected, so an installation without Redis is not broken by
 * a missing package.
 */
export class BullMQQueue implements JobQueue {
  readonly driver = 'bullmq' as const
  private queues = new Map<string, any>()
  private workers: any[] = []
  private connection: any

  private async lib() {
    const bullmq = await import('bullmq')
    if (!this.connection) {
      const { default: IORedis } = await import('ioredis')
      if (!env.redisUrl) {
        throw new Error('QUEUE_DRIVER=bullmq requires REDIS_URL to be set')
      }
      this.connection = new IORedis(env.redisUrl, { maxRetriesPerRequest: null })
    }
    return bullmq
  }

  private async queueFor(name: string) {
    const existing = this.queues.get(name)
    if (existing) return existing
    const { Queue } = await this.lib()
    const q = new Queue(name, { connection: this.connection })
    this.queues.set(name, q)
    return q
  }

  async enqueue<N extends JobName>(
    name: N,
    payload: JobPayloads[N],
    opts: EnqueueOptions = {},
  ): Promise<string> {
    const q = await this.queueFor(QUEUE_FOR[name])
    const job = await q.add(name, payload, {
      delay: opts.delayMs,
      attempts: opts.maxAttempts ?? 3,
      priority: opts.priority,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { age: 86_400, count: 5_000 },
      removeOnFail: false,
    })
    return String(job.id)
  }

  async enqueueMany<N extends JobName>(
    name: N,
    payloads: JobPayloads[N][],
    opts: EnqueueOptions = {},
  ): Promise<number> {
    if (payloads.length === 0) return 0
    const q = await this.queueFor(QUEUE_FOR[name])
    const jobs = await q.addBulk(
      payloads.map((data) => ({
        name,
        data,
        opts: {
          delay: opts.delayMs,
          attempts: opts.maxAttempts ?? 3,
          priority: opts.priority,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: { age: 86_400, count: 5_000 },
          removeOnFail: false,
        },
      })),
    )
    return jobs.length
  }

  async work(
    queue: string,
    concurrency: number,
    handlers: { [K in JobName]?: JobHandler<K> },
  ): Promise<void> {
    const { Worker } = await this.lib()
    const worker = new Worker(
      queue,
      async (job: any) => {
        const handler = handlers[job.name as JobName] as
          | JobHandler<JobName>
          | undefined
        if (!handler) throw new Error(`No handler registered for "${job.name}"`)
        await handler(job.data, {
          jobId: String(job.id),
          attempt: job.attemptsMade + 1,
          heartbeat: async () => {
            await job.extendLock(job.token, 60_000).catch(() => {})
          },
          isCancelled: async () => {
            const state = await job.getState()
            return state === 'failed' || state === 'completed'
          },
          log: (message: string, data?: unknown) =>
            console.log(`[${job.name}:${job.id}] ${message}`, data ?? ''),
        })
      },
      { connection: this.connection, concurrency: Math.max(1, concurrency) },
    )
    this.workers.push(worker)
    await new Promise<void>((resolve) => worker.on('closed', () => resolve()))
  }

  async stop(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.close()))
    await Promise.all(Array.from(this.queues.values()).map((q) => q.close()))
    await this.connection?.quit?.()
  }

  async counts(queue: string): Promise<Record<string, number>> {
    const q = await this.queueFor(queue)
    return q.getJobCounts()
  }
}
