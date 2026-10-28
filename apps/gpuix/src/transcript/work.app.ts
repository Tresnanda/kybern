// Fixture entry for `work.verify.ts`: the unchanged full app on the glass scratch daemon (`perf/glass/app.ts`, with its
// `glass-control.json` server), plus a second control server (`work-control.json`) that streams a busy agent turn
// (`perf/bench/workTurn.ts`) into the open thread through the production `applyEvent`. Harness-only.
//
// POST JSON `{action, …}`:
//   turn {turn, history, ago}   start turn `turn` (its message `ago` s back) and apply `history` ticks stamped `ago` s back
//   feed {count, intervalMs}    apply the next `count` ticks, one per `intervalMs`, stamped now (live arrivals)
//   step {count | to}           stop feeding; apply `count` ticks now, or every tick up to (not including) tick `to`
//   settle {turn}               end turn `turn`
//   open {match}                rows whose state key contains `match` start open when they mount (`setRowStateDefault`)
//   counters                    mounted host elements and components under the transcript (one fiber walk)
//   last-run                    the test id of the live turn's newest run row (null before `chunkRuns` existed)
//   open-next                   the next run whose calls have not started yet opens when it mounts (its first call's row key)
import { writeFileSync } from 'node:fs'
import path from 'node:path'

await import('../../perf/glass/app.ts')
// The glass entry keeps the fiber root but drops pacing-app's commit log; `work.perf.ts` counts commits from it.
const g = globalThis as Record<string, unknown>
const hook = g.__REACT_DEVTOOLS_GLOBAL_HOOK__ as { onCommitFiberRoot: (...args: unknown[]) => void }
const keep = hook.onCommitFiberRoot
hook.onCommitFiberRoot = (...args) => { keep(...args); console.error('[pacing-commit]', performance.now()) }
const state = await import('../state.ts')
const { applyEvent } = await import('../../../../packages/kybern-client/src/transcript.ts')
const { workTurnEvent, WORK_TICKS_PER_SEGMENT } = await import('../../perf/bench/workTurn.ts')
const { setRowStateDefault } = await import('./store.ts')

let seq = 5_000_000
let tick = 0
let timer: ReturnType<typeof setInterval> | undefined
let live = ''
const opened: string[] = []
setRowStateDefault((key) => (opened.some((match) => key.includes(match)) ? true : undefined))

function push(turn: string, payload: Record<string, unknown>, at: string) {
  const id = state.getState().selectedId!
  state.setThreadOpen(id, applyEvent(state.getState().open, { thread_id: id, turn_id: turn, seq: ++seq, at, ...payload } as never), payload.kind === 'assistant_text_delta')
}

const server = Bun.serve({ idleTimeout: 60, port: 0, hostname: '127.0.0.1', async fetch(req) {
  const body = await req.json() as { action: string; turn?: string; history?: number; ago?: number; count?: number; intervalMs?: number; match?: string; to?: number }
  try {
    if (body.action === 'turn') {
      const at = new Date(Date.now() - (body.ago ?? 60) * 1000).toISOString()
      live = body.turn!
      tick = 0
      push(live, { kind: 'turn_started', message_id: `${live}-user`, message: { parts: [{ type: 'text', text: 'Tidy the transcript rows and run the checks.' }] } }, at)
      for (let i = 0; i < (body.history ?? 0); i++) push(live, workTurnEvent(tick++, live), at)
    }
    if (body.action === 'feed') {
      clearInterval(timer)
      let left = body.count ?? WORK_TICKS_PER_SEGMENT
      timer = setInterval(() => {
        if (left-- <= 0) return clearInterval(timer)
        push(live, workTurnEvent(tick++, live), new Date().toISOString())
      }, body.intervalMs ?? 120)
    }
    if (body.action === 'step') {
      clearInterval(timer)
      const end = body.to ?? tick + (body.count ?? 1)
      while (tick < end) push(live, workTurnEvent(tick++, live), new Date().toISOString())
    }
    if (body.action === 'settle') {
      clearInterval(timer)
      push(body.turn ?? live, { kind: 'turn_completed', stop_reason: 'completed', usage: { input_tokens: 100, output_tokens: 100 }, duration_ms: 222_000, terminal_message_id: null }, new Date().toISOString())
    }
    if (body.action === 'open') opened.push(body.match!)
    if (body.action === 'open-next') {
      const segment = Math.floor(tick / WORK_TICKS_PER_SEGMENT) + (tick % WORK_TICKS_PER_SEGMENT >= 7 ? 1 : 0)
      opened.push(`group:tool:${live}-tool-${segment * 4}`)
      return Response.json({ match: opened.at(-1), segment, testId: `work-run-tool:${live}-tool-${segment * 4}` })
    }
    if (body.action === 'counters') {
      type Fiber = { tag?: number; type?: unknown; memoizedProps?: { testId?: string }; child?: Fiber; sibling?: Fiber }
      const root = (g.__glassFiberRoot as { current?: Fiber } | undefined)?.current
      let host = 0, components = 0, inside = false
      const walk = (fiber: Fiber | undefined, transcript: boolean) => {
        for (let f = fiber; f; f = f.sibling) {
          const here = transcript || f.memoizedProps?.testId === 'transcript-surface'
          if (here) { inside = true; if (typeof f.type === 'string') host++; else if (typeof f.type === 'function' || typeof f.type === 'object') components++ }
          walk(f.child, here)
        }
      }
      walk(root, false)
      return Response.json({ tick, blocks: state.getState().open.blocks.length, transcript: inside, hostElements: host, components })
    }
    if (body.action === 'last-run') {
      const chunks = await import('../shared/lib/workChunks.ts') as { chunkRuns?: (blocks: unknown[], tasks: Map<string, unknown>) => { kind: string; blocks: { id: string }[] }[] }
      const { buildWorkHierarchy, groupTurns } = await import('../../../../packages/kybern-client/src/transcript.ts')
      const group = groupTurns(state.getState().open.blocks).find((g) => g.turnId === live)
      const run = group && chunks.chunkRuns ? chunks.chunkRuns(buildWorkHierarchy(group.work).roots, new Map()).filter((c) => c.kind === 'run').at(-1) : undefined
      return Response.json({ testId: run ? `work-run-${run.blocks[0]!.id}` : null })
    }
    return Response.json({ tick, blocks: state.getState().open.blocks.length })
  } catch (e) { return Response.json({ error: String(e) }, { status: 500 }) }
} })
writeFileSync(path.join(process.env.KYBERN_CLIENT_CONFIG_DIR!, 'work-control.json'), JSON.stringify({ port: server.port }))
process.stdin.on('end', () => { clearInterval(timer); server.stop(true) })
export {}
