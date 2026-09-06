import type { MarkdownBlock } from "./markdownParser"
export interface MarkdownInput { consumer: number; source: string; baseRevision: number }
export interface MarkdownJob extends MarkdownInput { id: number }
export interface MarkdownReply { id: number; revision: number; prefix: number; blocks: MarkdownBlock[] }

/** Bound queued input and let an active prefix finish instead of starving streams. */
export function createMarkdownQueue(send: (job: MarkdownJob) => void) {
  const jobs = new Map<number, { input: MarkdownInput; resolve: (reply: MarkdownReply | null) => void; detach: () => void }>()
  let serial = 0
  let active: number | null = null
  let bytes = 0
  let closed = false
  const remove = (id: number) => {
    const job = jobs.get(id)
    if (job) { jobs.delete(id); bytes -= job.input.source.length * 2; job.detach() }
    return job
  }
  const dispose = () => {
    closed = true
    for (const id of jobs.keys()) remove(id)?.resolve(null)
    active = null
  }
  const pump = () => {
    if (closed || active !== null) return
    const next = jobs.entries().next().value
    if (!next) return
    active = next[0]
    try { send({ ...next[1].input, id: active }) } catch { dispose() }
  }
  return {
    request(input: MarkdownInput, signal: AbortSignal): Promise<MarkdownReply | null> {
      if (closed || signal.aborted || jobs.size >= 64 || bytes + input.source.length * 2 > 8 * 1024 * 1024) return Promise.resolve(null)
      return new Promise((resolve) => {
        const id = ++serial
        const abort = () => { remove(id)?.resolve(null) }
        jobs.set(id, { input, resolve, detach: () => signal.removeEventListener("abort", abort) })
        bytes += input.source.length * 2
        signal.addEventListener("abort", abort, { once: true })
        pump()
      })
    },
    receive(reply: MarkdownReply) {
      if (reply.id !== active) return
      remove(reply.id)?.resolve(reply)
      active = null
      pump()
    },
    dispose,
  }
}
