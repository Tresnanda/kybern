/**
 * What GPUIX does to load the lists and open a thread, as call sequences the bench can time.
 *
 * `current` is origin/main's GPUIX (state.ts before #248): lists are `projects.list {refresh_git:false}` and
 * `threads.list {}` together; an open is `threads.get {transcript_limit:120}`, then `events.subscribe` after the page.
 * `instant` is this branch's code itself (`src/transcript/openFlow.ts`, `src/nav/threadList.ts`), imported headlessly.
 */
import type { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import { applyEvent, seedFromGet, type ThreadState } from '../../../../packages/kybern-client/src/transcript.ts'
import { isChildThread, isInboundThread } from '../../../../packages/kybern-client/src/subagents.ts'
import { byPinnedThenNewest } from '../../src/machines/merged.ts'

export interface OpenResult {
  /** Click to first drawable content (a cached copy or the daemon's page, projected). */
  contentAt: number
  /** Where the first content came from. */
  from: 'cache' | 'daemon' | 'session'
  /** Click to a live stream (subscribed, replay finished). */
  liveAt: number
  blocks: number
  /** The state once live, for checks. */
  state: () => ThreadState
  close(): void
}

export interface Flow {
  name: string
  /** Cold or refresh list load; returns rows shown. */
  lists(client: KybernClient, first: boolean): Promise<{ threads: number; projects: number }>
  open(client: KybernClient, threadId: string, machineId: string): Promise<OpenResult>
  /** Called after a thread was closed (the reader left it). */
  closed?(client: KybernClient, threadId: string, machineId: string): Promise<void> | void
  dispose?(): Promise<void> | void
}

export const currentFlow: Flow = {
  name: 'current',
  async lists(client, first) {
    const [p, t] = await Promise.all([client.call('projects.list', first ? { refresh_git: false } : {}), client.call('threads.list', {})])
    const listed = t.threads.filter(th => !isChildThread(th) && !isInboundThread(th) && th.status !== 'archived').sort(byPinnedThenNewest)
    return { threads: listed.length, projects: p.projects.length }
  },
  async open(client, id) {
    const t0 = performance.now()
    const res = await client.call('threads.get', { thread_id: id, transcript_limit: 120, include_tool_output: false })
    let state = seedFromGet(res)
    const contentAt = performance.now() - t0
    let unsubscribe = () => {}
    await new Promise<void>(resolve => {
      const sub = client.subscribeEvents(
        { thread_id: id, after_seq: res.thread.last_seq, include_tool_output: false },
        event => { state = applyEvent(state, event) },
        (_head, replay) => { if (!replay.supported) resolve() },
        () => resolve(),
      )
      unsubscribe = () => sub.unsubscribe()
    })
    return { contentAt, from: 'daemon', liveAt: performance.now() - t0, blocks: state.blocks.length, state: () => state, close: unsubscribe }
  },
}
