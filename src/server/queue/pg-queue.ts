import 'server-only'
import { randomUUID } from 'node:crypto'
import { prisma } from '@/server/db/client'
import type {
  EnqueueOptions,
  JobHandler,
  JobName,
  JobPayloads,
  JobQueue,
} from './types'
import { QUEUE_FOR } from './types'

/**
 * Postgres-backed queue.
 *
 * Chosen as the default because it gives real at-least-once semantics —
 * SELECT ... FOR UPDATE SKIP LOCKED, visibility timeouts, retry with backoff,
 * dead-lettering — without requiring a second datastore to be installed.
 * `BullMQQueue` implements the same interface for deployments that have Redis.
 */

const VISIBILITY_TIMEOUT_MS = 5 * 60 * 1000
const POLL_INTERVAL_MS = 1000
const BACKOFF_BASE_MS = 5_000

interface ClaimedRow {
  id: string
  name: string
  payload: unknown
  attempts: number
  maxAttempts: number
}

export class PgQueue implements JobQueue {
  readonly driver = 'pg' as const
  private running = false
  private readonly workerId = `${process.pid}-${randomUUID().slice(0, 8)}`
  private activeTimers = new Set<NodeJS.Timeout>()

  async enqueue<N extends JobName>(
    name: N,
    payload: JobPayloads[N],
    opts: EnqueueOptions = {},
  ): Promise<string> {
    const job = await prisma.queueJob.create({
      data: {
        queue: QUEUE_FOR[name],
        name,
        payload: payload as object,
        runAt: new Date(Date.now() + (opts.delayMs ?? 0)),
        maxAttempts: opts.maxAttempts ?? 3,
        priority: opts.priority ?? 0,
      },
      select: { id: true },
    })
    return job.id
  }

  /**
   * Atomically claim one job. SKIP LOCKED means N workers never contend for the
   * same row, and the reclaim clause returns jobs whose worker died holding a lock.
   */
  private async claim(queue: string): Promise<ClaimedRow | null> {
    const staleBefore = new Date(Date.now() - VISIBILITY_TIMEOUT_MS)
    const rows = await prisma.$queryRaw<ClaimedRow[]>`
      UPDATE "QueueJob" AS j
      SET "state" = 'ACTIVE',
          "lockedAt" = NOW(),
          "lockedBy" = ${this.workerId},
          "attempts" = j."attempts" + 1,
          "updatedAt" = NOW()
      WHERE j."id" = (
        SELECT c."id" FROM "QueueJob" c
        WHERE c."queue" = ${queue}
          AND (
            (c."state" = 'WAITING' AND c."runAt" <= NOW())
            OR (c."state" = 'ACTIVE' AND c."lockedAt" < ${staleBefore})
          )
        ORDER BY c."priority" DESC, c."runAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING j."id", j."name", j."payload", j."attempts", j."maxAttempts"
    `
    return rows[0] ?? null
  }

  private async heartbeat(id: string): Promise<void> {
    await prisma.queueJob.updateMany({
      where: { id, state: 'ACTIVE' },
      data: { lockedAt: new Date() },
    })
  }

  private async complete(id: string): Promise<void> {
    await prisma.queueJob.update({
      where: { id },
      data: { state: 'COMPLETED', completedAt: new Date(), lockedBy: null },
    })
  }

  private async fail(row: ClaimedRow, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err)
    const exhausted = row.attempts >= row.maxAttempts
    // Exponential backoff with jitter; DEAD is terminal and keeps lastError for triage.
    const delay =
      BACKOFF_BASE_MS * 2 ** (row.attempts - 1) * (0.75 + Math.random() * 0.5)
    await prisma.queueJob.update({
      where: { id: row.id },
      data: {
        state: exhausted ? 'DEAD' : 'WAITING',
        lastError: message.slice(0, 2000),
        lockedBy: null,
        lockedAt: null,
        runAt: exhausted ? undefined : new Date(Date.now() + delay),
      },
    })
  }

  async work(
    queue: string,
    concurrency: number,
    handlers: { [K in JobName]?: JobHandler<K> },
  ): Promise<void> {
    this.running = true
    const loops = Array.from({ length: Math.max(1, concurrency) }, (_, i) =>
      this.loop(queue, handlers, i),
    )
    await Promise.all(loops)
  }

  private async loop(
    queue: string,
    handlers: { [K in JobName]?: JobHandler<K> },
    slot: number,
  ): Promise<void> {
    // Stagger slots so N workers do not poll in lockstep.
    await this.wait(slot * 120)

    while (this.running) {
      let row: ClaimedRow | null = null
      try {
        row = await this.claim(queue)
      } catch (err) {
        console.error(`[queue:${queue}] claim failed`, err)
        await this.wait(POLL_INTERVAL_MS * 3)
        continue
      }

      if (!row) {
        await this.wait(POLL_INTERVAL_MS)
        continue
      }

      const handler = handlers[row.name as JobName] as
        | JobHandler<JobName>
        | undefined

      if (!handler) {
        await this.fail(row, new Error(`No handler registered for "${row.name}"`))
        continue
      }

      const hb = setInterval(() => {
        void this.heartbeat(row!.id).catch(() => {})
      }, VISIBILITY_TIMEOUT_MS / 3)
      this.activeTimers.add(hb)

      const started = Date.now()
      try {
        await handler(row.payload as never, {
          jobId: row.id,
          attempt: row.attempts,
          heartbeat: () => this.heartbeat(row!.id),
          isCancelled: async () => {
            const j = await prisma.queueJob.findUnique({
              where: { id: row!.id },
              select: { state: true },
            })
            return j?.state !== 'ACTIVE'
          },
          log: (message, data) =>
            console.log(`[${row!.name}:${row!.id}] ${message}`, data ?? ''),
        })
        await this.complete(row.id)
        console.log(
          `[queue:${queue}] ${row.name} ${row.id} ok in ${Date.now() - started}ms`,
        )
      } catch (err) {
        console.error(`[queue:${queue}] ${row.name} ${row.id} failed`, err)
        await this.fail(row, err)
      } finally {
        clearInterval(hb)
        this.activeTimers.delete(hb)
      }
    }
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.activeTimers.delete(t)
        resolve()
      }, ms)
      this.activeTimers.add(t)
    })
  }

  async stop(): Promise<void> {
    this.running = false
    for (const t of this.activeTimers) clearTimeout(t as NodeJS.Timeout)
    this.activeTimers.clear()
  }

  async counts(queue: string): Promise<Record<string, number>> {
    const grouped = await prisma.queueJob.groupBy({
      by: ['state'],
      where: { queue },
      _count: { _all: true },
    })
    const out: Record<string, number> = {
      WAITING: 0,
      ACTIVE: 0,
      COMPLETED: 0,
      FAILED: 0,
      DEAD: 0,
    }
    for (const g of grouped) out[g.state] = g._count._all
    return out
  }
}
