// The memory fixture plus `replay`: a stored thread's events streamed back
// through the live path (`applyEvent` → `setThreadOpen`, text deltas paced
// as `textOnly`), as if its turns were running now. Read-only on the daemon.
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
await import('../memory/app.ts')
const state = await import('../../src/state.ts')
const { applyEvent, emptyThreadState } = await import('../../../../packages/kybern-client/src/transcript.ts')
const { loadEarlier } = await import('../../src/transcript/store.ts')
const { openTab } = await import('../../src/tabs/open.ts')
const { heapStats } = await import('bun:jsc')
type Event = Parameters<typeof applyEvent>[1]

let replay: { done: boolean; applied: number; total: number } = { done: true, applied: 0, total: 0 }
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 255, async fetch(req) {
  const body = await req.json() as { action: string; thread?: string; perFrame?: number; frameMs?: number; pages?: number; tab?: Parameters<typeof openTab>[1]; file?: string }
  // Earlier history pages for the open thread, as a reader scrolling up.
  if (body.action === 'earlier') { for (let i = 0; i < (body.pages ?? 1) && state.getState().open.nextBeforeSeq != null; i++) await loadEarlier() }
  if (body.action === 'tab') openTab(state.getState().selectedId!, body.tab!)
  // Live heap only: a full collection first, then JSC's object census.
  if (body.action === 'census') {
    Bun.gc(true)
    const stats = heapStats()
    return Response.json({ heapSize: stats.heapSize, heapCapacity: stats.heapCapacity, extra: stats.extraMemorySize, objects: stats.objectCount, memory: process.memoryUsage(), types: Object.fromEntries(Object.entries(stats.objectTypeCounts).sort((a, b) => b[1] - a[1]).slice(0, 40)) })
  }
  // The live reply's native document (`transcript/streamDocument.ts`), without painting: one document per reply,
  // updated as it grows by `step` characters, then released.
  if (body.action === 'doc-churn') {
    const renderer = ((globalThis as Record<string, unknown>).__gpuixRenderHost as { renderer: Record<string, (...args: unknown[]) => Promise<{ id: string; revision: number }> & void> }).renderer
    const text = readFileSync(body.file!, 'utf8')
    const replies = (body as { replies?: number }).replies ?? 10, step = (body as { step?: number }).step ?? 24
    let updates = 0
    for (let r = 0; r < replies; r++) {
      let doc = await renderer.createMarkdownDocument!({ text: text.slice(0, step) })
      for (let end = step * 2; end < text.length; end += step) { doc = await renderer.updateMarkdownDocument!(doc.id, { text: text.slice(0, end), expectedRevision: doc.revision }); updates++ }
      renderer.releaseMarkdownDocument!(doc.id)
    }
    return Response.json({ updates })
  }
  if (body.action === 'snapshot') { Bun.gc(true); await Bun.write(body.file!, JSON.stringify(Bun.generateHeapSnapshot())); return Response.json({ file: body.file }) }
  if (body.action === 'replay') {
    const id = body.thread!, client = state.getClient()!
    await state.selectThread(id)
    const events: Event[] = []
    const sub = client.subscribeEvents({ thread_id: id, after_seq: 0, include_tool_output: false }, event => { events.push(event as Event) })
    const { thread } = await client.call('threads.get', { thread_id: id, transcript_limit: 1, include_tool_output: false })
    for (const until = Date.now() + 30000; events.at(-1)?.seq !== thread.last_seq && Date.now() < until;) await Bun.sleep(100)
    sub.unsubscribe()
    replay = { done: false, applied: 0, total: events.length }
    let open = { ...emptyThreadState(), thread, loaded: true }
    state.setThreadOpen(id, open)
    const perFrame = body.perFrame ?? 4, frameMs = body.frameMs ?? 16
    void (async () => {
      for (let i = 0; i < events.length; i += perFrame) {
        for (const event of events.slice(i, i + perFrame)) {
          open = applyEvent(open, event)
          state.setThreadOpen(id, open, event.kind === 'assistant_text_delta' || event.kind === 'assistant_thinking_delta')
          replay.applied++
        }
        await Bun.sleep(frameMs)
      }
      replay.done = true
    })()
  }
  const blocks = state.getState().open.blocks, last = blocks.at(-1) as { kind?: string; text?: string } | undefined
  return Response.json({ ...replay, blocks: blocks.length, lastKind: last?.kind, lastChars: typeof last?.text === 'string' ? last.text.length : null })
} })
writeFileSync(path.join(process.env.KYBERN_CLIENT_CONFIG_DIR!, 'memlog-control.json'), JSON.stringify({ port: server.port }))
process.stdin.on('end', () => server.stop(true))
