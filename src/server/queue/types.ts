/**
 * Queue abstraction (§17).
 *
 * Application code enqueues against this interface only. Swapping Redis/BullMQ
 * for the Postgres driver (or the reverse) is a config change, not a code change.
 */

export interface JobPayloads {
  'discovery.run': { jobId: string; workspaceId: string }
  'audit.site': {
    businessId: string
    workspaceId: string
    depth: 'QUICK' | 'STANDARD' | 'DEEP'
    trigger: 'discovery' | 'manual' | 'recheck' | 'scheduled'
    /** Restrict the audit to specific stages, for targeted re-audits (§26). */
    scopes?: Array<'crawl' | 'technical' | 'seo' | 'performance' | 'ux'>
  }
  'export.run': { exportJobId: string; workspaceId: string }
  'import.run': { importJobId: string; workspaceId: string }
}

export type JobName = keyof JobPayloads

export const QUEUE_FOR: Record<JobName, string> = {
  'discovery.run': 'discovery',
  'audit.site': 'audit',
  'export.run': 'export',
  // Imports are IO-light but resolve every row against existing leads; they
  // share the export queue rather than competing with audits for workers.
  'import.run': 'export',
}

export interface EnqueueOptions {
  /** Delay before the job becomes eligible, in milliseconds. */
  delayMs?: number
  maxAttempts?: number
  /** Higher runs first. */
  priority?: number
}

export interface QueuedJob<N extends JobName = JobName> {
  id: string
  name: N
  payload: JobPayloads[N]
  attempts: number
  maxAttempts: number
}

export type JobHandler<N extends JobName> = (
  payload: JobPayloads[N],
  ctx: JobContext,
) => Promise<void>

export interface JobContext {
  jobId: string
  attempt: number
  /** Extends the visibility lock for long-running work. */
  heartbeat(): Promise<void>
  /** Cooperative cancellation — checked between pipeline stages. */
  isCancelled(): Promise<boolean>
  log(message: string, data?: unknown): void
}

export interface JobQueue {
  readonly driver: 'pg' | 'bullmq'
  enqueue<N extends JobName>(
    name: N,
    payload: JobPayloads[N],
    opts?: EnqueueOptions,
  ): Promise<string>
  /**
   * Bulk enqueue. Fanning out hundreds of audits one call at a time is hundreds
   * of round trips to the database; this collapses them into one insert.
   */
  enqueueMany<N extends JobName>(
    name: N,
    payloads: JobPayloads[N][],
    opts?: EnqueueOptions,
  ): Promise<number>
  /** Runs until `stop()` — used by the worker entrypoint. */
  work(
    queue: string,
    concurrency: number,
    handlers: { [K in JobName]?: JobHandler<K> },
  ): Promise<void>
  stop(): Promise<void>
  counts(queue: string): Promise<Record<string, number>>
}
