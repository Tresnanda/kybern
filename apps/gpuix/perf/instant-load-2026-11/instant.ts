/**
 * The bench's `instant` flow: this branch's GPUIX code, imported headlessly.
 * - Lists: `threads.list {settled_limit: 25}` with `projects.list` on first load, `threads.list {since_seq}` merged by
 *   `threadListCursor` afterwards (as `state.ts` `loadLists`).
 * - Opens: `openThreadStream` (`src/transcript/openFlow.ts`) with the bun:sqlite `TranscriptCache` of
 *   `src/transcript/diskCache.ts` in a scratch file (persisting across the bench's runs and daemons), and a session
 *   that lingers after it is closed, as `state.ts` keeps it (reopened within 5 minutes: drawn from memory, no call).
 * Not modelled: prefetch (the bench clicks rows it never hovered) and the app's render/paint (see app-bench.ts).
 */
import { rmSync } from 'node:fs'
import type { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import { applyThreadList, refreshParams, FIRST_LIST_SETTLED_LIMIT, type ThreadListState } from '../../../../packages/kybern-client/src/threadListCursor.ts'
import { emptyThreadState, type ThreadState } from '../../../../packages/kybern-client/src/transcript.ts'
import { isChildThread, isInboundThread } from '../../../../packages/kybern-client/src/subagents.ts'
import { byPinnedThenNewest } from '../../src/machines/merged.ts'
import { openThreadStream, type OpenStream } from '../../src/transcript/openFlow.ts'
import { cacheableState, createTranscriptCache, openSqliteStore } from '../../src/transcript/diskCache.ts'
import type { Flow, OpenResult } from './flows.ts'

export function instantFlow(cacheFile: string, options: { linger?: boolean } = {}): Flow {
  rmSync(cacheFile, { force: true }); rmSync(`${cacheFile}-wal`, { force: true }); rmSync(`${cacheFile}-shm`, { force: true })
  const store = openSqliteStore(cacheFile)
  const cache = createTranscriptCache(store)
  const capable = new WeakMap<KybernClient, boolean>()
  let list: { owner: KybernClient; state: ThreadListState } | undefined
  /** Closed sessions kept warm (the app's linger), keyed by thread. */
  const lingering = new Map<string, { owner: KybernClient; state: () => ThreadState; stream: OpenStream }>()
  const linger = options.linger ?? true

  return {
    name: 'instant',
    async lists(client, first) {
      const previous = !first && list?.owner === client ? list.state : undefined
      const request = previous ? refreshParams(previous) : { settled_limit: FIRST_LIST_SETTLED_LIMIT }
      // As `state.ts`: a thread-driven refresh on a daemon with cursors skips the projects' Git probes.
      const [p, t] = await Promise.all([client.call('projects.list', first || previous?.headSeq !== undefined ? { refresh_git: false } : {}), client.call('threads.list', request)])
      capable.set(client, t.head_seq !== undefined)
      const state = applyThreadList(previous, request, t)
      list = { owner: client, state }
      const listed = state.threads.filter(th => !isChildThread(th) && !isInboundThread(th) && th.status !== 'archived').sort(byPinnedThenNewest)
      return { threads: listed.length, projects: p.projects.length }
    },
    async open(client, id, machineId): Promise<OpenResult> {
      const t0 = performance.now()
      const warm = lingering.get(id)
      if (warm && warm.owner === client) {
        // The app's lingering session: its state is current (it kept folding events), drawn without a call.
        lingering.delete(id)
        const contentAt = performance.now() - t0
        const state = warm.state()
        return { contentAt, from: 'session', liveAt: contentAt, blocks: state.blocks.length, state: warm.state, close: () => { lingering.set(id, warm) } }
      }
      for (const [key, other] of lingering) if (other.owner !== client) { other.stream.stop(); lingering.delete(key) }
      const cached = await cache.load(machineId, id)
      let state = emptyThreadState()
      let contentAt: number | undefined, from: OpenResult['from'] = 'daemon'
      const stream = openThreadStream(client, { threadId: id, ...(cached ? { cached } : {}), capable: capable.get(client) }, {
        get: () => state,
        learned: value => capable.set(client, value),
        set: (next, source) => {
          state = next
          if (contentAt === undefined && (next.loaded || next.blocks.length)) { contentAt = performance.now() - t0; from = source === 'cache' ? 'cache' : 'daemon' }
        },
      })
      await stream.live
      const liveAt = performance.now() - t0
      cache.schedule(machineId, id, () => ({ lastSeq: state.lastSeq, data: cacheableState(state) }))
      await cache.flush()
      const read = () => state
      return {
        contentAt: contentAt ?? liveAt, from, liveAt, blocks: state.blocks.length, state: read,
        close: () => { if (linger) lingering.set(id, { owner: client, state: read, stream }); else stream.stop() },
      }
    },
    async dispose() {
      for (const { stream } of lingering.values()) stream.stop()
      lingering.clear()
      await cache.flush()
      store.close()
    },
  }
}
