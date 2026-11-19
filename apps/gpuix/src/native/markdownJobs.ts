/** One JS-side queue in front of the native Markdown document worker.
 *
 * Native accepts at most eight pending jobs and rejects the ninth with "Markdown queue is full (8 jobs)". A page that mounts
 * many bodies at once (a pull request description cut into a dozen pieces by its images and diffs) would otherwise reject some
 * of them. This queue keeps fewer jobs in flight than native allows, holds the rest in order, drops a job whose owner went
 * away before it started, and treats a queue-full answer (another caller shares the worker) as "wait and try again". */

export const MARKDOWN_JOB_LIMIT = 6
const RETRY_FIRST_MS = 25
const RETRY_MAX_MS = 250
/** A worker that stays full this long is stuck, not busy: the caller shows its fallback instead. */
const RETRY_GIVE_UP_MS = 15_000

/** The reason a queued job never ran. Callers whose owner is gone ignore it. */
export class MarkdownJobCancelled extends Error {
  constructor() { super('Markdown job cancelled'); this.name = 'MarkdownJobCancelled' }
}

/** Matches native's refusal by its wording; the text is only matched here, never shown. */
export function isMarkdownQueueFull(failure: unknown): boolean {
  const { message } = Object(failure) as { message?: unknown }
  return typeof message === 'string' && /queue is full/i.test(message)
}

export interface MarkdownTicket<T> {
  result: Promise<T>
  /** Drops the job if it has not started; a started job runs on and its result is the caller's to release. */
  cancel(): void
}

interface Job {
  run: () => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  started: boolean
  cancelled: boolean
  attempts: number
  firstFullAt: number
}

export interface MarkdownQueueOptions {
  limit?: number
  retryFirstMs?: number
  retryMaxMs?: number
  giveUpMs?: number
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}

export class MarkdownJobQueue {
  private readonly limit: number
  private readonly retryFirst: number
  private readonly retryMax: number
  private readonly giveUp: number
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (timer: unknown) => void
  private readonly queue: Job[] = []
  private running = 0
  private waiting: unknown = null

  constructor(options: MarkdownQueueOptions = {}) {
    this.limit = options.limit ?? MARKDOWN_JOB_LIMIT
    this.retryFirst = options.retryFirstMs ?? RETRY_FIRST_MS
    this.retryMax = options.retryMaxMs ?? RETRY_MAX_MS
    this.giveUp = options.giveUpMs ?? RETRY_GIVE_UP_MS
    this.now = options.now ?? Date.now
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = options.clearTimer ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>))
  }

  /** Jobs started and not finished, and jobs waiting for a slot. */
  get stats() { return { running: this.running, queued: this.queue.length } }

  /** `priority: 'high'` goes ahead of waiting normal jobs (a streaming answer's next update), never ahead of a running one. */
  submit<T>(run: () => Promise<T>, priority: 'normal' | 'high' = 'normal'): MarkdownTicket<T> {
    let job!: Job
    const result = new Promise<T>((resolve, reject) => {
      job = { run, resolve: resolve as (value: unknown) => void, reject, started: false, cancelled: false, attempts: 0, firstFullAt: 0 }
    })
    if (priority === 'high') {
      const at = this.queue.findIndex(waiting => waiting.attempts === 0)
      this.queue.splice(at < 0 ? this.queue.length : at, 0, job)
    } else this.queue.push(job)
    this.pump()
    return {
      result,
      cancel: () => {
        if (job.started || job.cancelled) return
        job.cancelled = true
        const at = this.queue.indexOf(job)
        if (at >= 0) this.queue.splice(at, 1)
        job.reject(new MarkdownJobCancelled())
      },
    }
  }

  private pump() {
    if (this.waiting != null) return
    while (this.running < this.limit && this.queue.length) {
      const job = this.queue.shift()!
      if (job.cancelled) continue
      this.start(job)
    }
  }

  private start(job: Job) {
    job.started = true
    this.running++
    let call: Promise<unknown>
    try { call = job.run() } catch (error) { call = Promise.reject(error) }
    call.then(value => { this.running--; job.resolve(value); this.wake() }, error => {
      this.running--
      if (isMarkdownQueueFull(error) && !job.cancelled) {
        if (!job.firstFullAt) job.firstFullAt = this.now()
        if (this.now() - job.firstFullAt < this.giveUp) {
          // Native is full of work this queue did not start. Put the job back first in line and ask again shortly; a
          // finishing job of ours also wakes it, so it never waits longer than a slot takes to open.
          job.started = false
          job.attempts++
          this.queue.unshift(job)
          this.backOff(job.attempts)
          return
        }
      }
      job.reject(error)
      this.wake()
    })
  }

  /** A slot opened: a job waiting out a queue-full answer need not wait for its timer. */
  private wake() {
    if (this.waiting != null) { this.clearTimer(this.waiting); this.waiting = null }
    this.pump()
  }

  private backOff(attempts: number) {
    if (this.waiting != null) return
    const delay = Math.min(this.retryMax, this.retryFirst * 2 ** Math.min(attempts - 1, 8))
    this.waiting = this.setTimer(() => { this.waiting = null; this.pump() }, delay)
  }

  /** Test and shutdown hook: stops the retry timer. */
  dispose() {
    if (this.waiting != null) { this.clearTimer(this.waiting); this.waiting = null }
    for (const job of this.queue.splice(0)) job.reject(new MarkdownJobCancelled())
  }
}

const queues = new WeakMap<object, MarkdownJobQueue>()
/** The queue in front of one renderer's worker (one per window). */
export function markdownQueue(renderer: object): MarkdownJobQueue {
  let queue = queues.get(renderer)
  if (!queue) { queue = new MarkdownJobQueue(); queues.set(renderer, queue) }
  return queue
}
