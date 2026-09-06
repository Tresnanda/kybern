export interface HighlightInput {
  code: string
  lang: string
  dark: boolean
  cache: boolean
}
export interface HighlightJob extends HighlightInput { id: number }
export interface HighlightReply { id: number; html: string | null }

/** One worker job at a time; removed/unmounted consumers release queued work.
 * Limits both queued strings and count. Overload degrades to readable plain text. */
export function createHighlightQueue(send: (job: HighlightJob) => void) {
  const jobs = new Map<number, { input: HighlightInput; resolve: (html: string | null) => void; detach: () => void }>()
  let serial = 0
  let active: number | null = null
  let bytes = 0
  let closed = false
  const remove = (id: number) => {
    const job = jobs.get(id)
    if (job) {
      jobs.delete(id)
      bytes -= job.input.code.length * 2
      job.detach()
    }
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
    request(input: HighlightInput, signal?: AbortSignal): Promise<string | null> {
      if (closed || signal?.aborted || jobs.size >= 64 || bytes + input.code.length * 2 > 4 * 1024 * 1024) return Promise.resolve(null)
      return new Promise((resolve) => {
        const id = ++serial
        const abort = () => { remove(id)?.resolve(null) }
        jobs.set(id, { input, resolve, detach: () => signal?.removeEventListener("abort", abort) })
        bytes += input.code.length * 2
        signal?.addEventListener("abort", abort, { once: true })
        pump()
      })
    },
    receive(reply: HighlightReply) {
      if (reply.id !== active) return
      remove(reply.id)?.resolve(reply.html)
      active = null
      pump()
    },
    dispose,
  }
}
