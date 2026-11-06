/** Opt-in startup timeline; dormant in normal sessions. Uses wall time so a
 * parent harness can relate module evaluation to process spawning. */
export function startupMark(phase: string, detail?: Record<string, unknown>) {
  if (process.env.KYBERN_STARTUP_TRACE === '1') console.error('[kybern-startup]', JSON.stringify({ phase, at: Date.now(), ...detail }))
}
startupMark('first-module')

/**
 * Thread opens on the same timeline (`perf/instant-load-2026-11`): `thread-click` when a row, tab or shortcut asks
 * for a thread, `thread-first-content` when its pane first has something to draw (a cached copy, a session another
 * pane holds, or the daemon's page), and `thread-content-frame` on the next native frame after that. Dormant unless
 * KYBERN_STARTUP_TRACE=1: nothing is recorded or allocated otherwise.
 */
const opening = new Map<string, { at: number; source: string }>()
export function traceThreadClick(id: string, source = 'click') {
  if (process.env.KYBERN_STARTUP_TRACE !== '1') return
  // A click followed by the selection it causes keeps the click's time.
  if (opening.has(id) && source !== 'click') return
  opening.set(id, { at: Date.now(), source })
  startupMark('thread-click', { id, source })
  if (opening.size > 32) opening.delete(opening.keys().next().value!)
}
/** `afterFrame` runs once on the next native frame (state.ts passes `onFrame`); content is `loaded` or any block. */
export function traceThreadContent(id: string, open: { loaded: boolean; blocks: readonly unknown[] }, from: string, afterFrame?: (run: () => void) => void) {
  if (process.env.KYBERN_STARTUP_TRACE !== '1') return
  const pending = opening.get(id)
  if (!pending || (!open.loaded && !open.blocks.length)) return
  opening.delete(id)
  const ms = Date.now() - pending.at
  startupMark('thread-first-content', { id, from, ms, blocks: open.blocks.length })
  afterFrame?.(() => startupMark('thread-content-frame', { id, from, ms: Date.now() - pending.at }))
}
