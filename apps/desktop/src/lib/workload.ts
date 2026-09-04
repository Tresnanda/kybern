/** Map without launching an unbounded number of expensive RPCs/processes. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return []
  const workerCount = Math.min(
    items.length,
    Math.max(1, Math.floor(concurrency))
  )
  const results = new Array<R>(items.length)
  let cursor = 0

  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await mapper(items[index]!, index)
    }
  }

  await Promise.all(Array.from({ length: workerCount }, worker))
  return results
}

/** Historical and whole-thread cards load metadata; patches are per-file follow-ups. */
export function diffSummaryRequest(threadId: string, turnId?: string) {
  return {
    thread_id: threadId,
    ...(turnId ? { turn_id: turnId } : {}),
    include_patch: false as const,
  }
}

export const LARGE_SOURCE_MAX_BYTES = 128 * 1024
export const LARGE_SOURCE_MAX_LINES = 4_000

/** Shiki is intentionally skipped when its token DOM would be more expensive than useful. */
export function shouldHighlightSource(content: string): boolean {
  if (content.length > LARGE_SOURCE_MAX_BYTES) return false
  let lines = 1
  for (let index = 0; index < content.length; index++) {
    if (content.charCodeAt(index) === 10 && ++lines > LARGE_SOURCE_MAX_LINES)
      return false
  }
  return true
}

export function countLines(content: string): number {
  if (!content) return 0
  let lines = 1
  for (let index = 0; index < content.length; index++) {
    if (content.charCodeAt(index) === 10) lines++
  }
  return lines
}

export interface VirtualRange {
  start: number
  end: number
  before: number
  after: number
}

/** Fixed-row virtual window used by the Explorer tree. */
export function virtualRange(
  total: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight = 28,
  overscan = 8
): VirtualRange {
  if (total <= 0) return { start: 0, end: 0, before: 0, after: 0 }
  const visible = Math.max(
    1,
    Math.ceil(Math.max(0, viewportHeight) / rowHeight)
  )
  const start = Math.max(
    0,
    Math.floor(Math.max(0, scrollTop) / rowHeight) - overscan
  )
  const end = Math.min(total, start + visible + overscan * 2)
  return {
    start,
    end,
    before: start * rowHeight,
    after: (total - end) * rowHeight,
  }
}
