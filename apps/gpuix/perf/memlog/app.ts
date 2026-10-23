// The memory fixture plus `replay`: a stored thread's events streamed back
// through the live path (`applyEvent` → `setThreadOpen`, text deltas paced
// as `textOnly`), as if its turns were running now. Read-only on the daemon.
import { writeFileSync } from 'node:fs'
import path from 'node:path'
await import('../memory/app.ts')
const state = await import('../../src/state.ts')
const { applyEvent, emptyThreadState } = await import('../../../../packages/kybern-client/src/transcript.ts')
type Event = Parameters<typeof applyEvent>[1]

let replay: { done: boolean; applied: number; total: number } = { done: true, applied: 0, total: 0 }
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 255, async fetch(req) {
  const body = await req.json() as { action: string; thread?: string; perFrame?: number; frameMs?: number }
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
