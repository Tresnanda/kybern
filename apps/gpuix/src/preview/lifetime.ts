// A browser tab's lifetime (ADE-128). Closing a thread's last browser tab ends its page: the page, its history, relays,
// tickets, web view and Fast choices go at once, so the next browser tab starts at the servers list.
// A forward opened for a preview (the daemon marks it `origin: 'preview'`) has a lease on the daemon (#350): every
// `FORWARD_KEEP_MS` this app renews (`ports.keep`) the preview forwards its own open browsers show, and once more as soon as a
// forward starts being shown. The daemon closes a forward nobody renews, so a quit, crash, closed window or lost connection
// never leaves one open, and a window never stops a forward that another window still shows. Manual forwards are never renewed
// or stopped here. Nothing here touches React, the daemon or the tab stores: `PreviewIntegration` passes them in.
import type { PortForward } from '../../../../packages/kybern-client/src/types.ts'

/** How often the preview forwards this app shows are renewed; the daemon's lease is three times this (30 s). */
export const FORWARD_KEEP_MS = 10_000

/** What one thread's browser shows: the forwarded servers it names (machine and remote port) and the loopback ports it loads. */
export interface PreviewUse { machines: { id: string; port: number }[]; ports: number[] }

/** The slice of a browser's state that names what it shows. */
export interface UseSource {
  entries: readonly { address: string; url: string; frameUrl?: string; machine?: { id: string; port: number } }[]
  attemptedMachine?: { id: string; port: number }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])
/** The port of a loopback address (a forward's `http://localhost:<local>` or Fast `https://localhost:<https>`), else null. */
export function loopbackPort(address: string): number | null {
  try {
    const url = new URL(address)
    if (!LOOPBACK.has(url.hostname) || (url.protocol !== 'http:' && url.protocol !== 'https:')) return null
    return Number(url.port) || (url.protocol === 'https:' ? 443 : 80)
  } catch { return null }
}

/** Everything a browser could load from a forward: its history (back and forward open those again) and the server it is opening. */
export function previewUse(state: UseSource): PreviewUse {
  const machines: PreviewUse['machines'] = [], ports: number[] = []
  for (const entry of state.entries) {
    if (entry.machine) machines.push({ id: entry.machine.id, port: entry.machine.port })
    for (const address of [entry.address, entry.url]) { const port = loopbackPort(address); if (port !== null) ports.push(port) }
  }
  if (state.attemptedMachine) machines.push({ id: state.attemptedMachine.id, port: state.attemptedMachine.port })
  return { machines, ports }
}

export const forwardInUse = (forward: Pick<PortForward, 'machine_id' | 'remote_port' | 'local_port' | 'https_port'>, uses: readonly PreviewUse[]): boolean =>
  uses.some(use => use.machines.some(m => m.id === forward.machine_id && m.port === forward.remote_port) || use.ports.some(port => port === forward.local_port || port === forward.https_port))

export interface LifetimeDeps {
  /** Threads that hold browser state. */
  threads(): readonly string[]
  /** A browser tab of the thread is open (on screen or remembered while the thread is off screen), or its page floats. */
  open(threadId: string): boolean
  /** Forget the thread's page: what a new browser tab shows is the servers list. */
  dispose(threadId: string): void
  /** What each open browser shows. */
  uses(): readonly PreviewUse[]
  /** This machine's forwards (`ports.list`, kept current by `ports.changed`). */
  forwards(): readonly PortForward[]
  /** Renew these preview forwards' leases (`ports.keep`). */
  keep(ids: string[]): Promise<unknown>
  /** Calls `listener` when tabs, browsers or forwards change. */
  subscribe(listener: () => void): () => void
  keepMs?: number
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}

/** The preview forwards an open browser shows. */
const shownForwards = (forwards: readonly PortForward[], uses: readonly PreviewUse[]): string[] =>
  forwards.filter(forward => forward.origin === 'preview' && forwardInUse(forward, uses)).map(forward => forward.id)

/** Start watching; returns the way to stop. Changes are handled together on the next tick, so a tab moved between groups (taken
 *  out of one and put in another in the same update) never reads as closed. */
export function watchPreviewLifetime(deps: LifetimeDeps): () => void {
  const every = deps.keepMs ?? FORWARD_KEEP_MS
  const setTimer = deps.setTimer ?? ((run, ms) => setTimeout(run, ms)), clearTimer = deps.clearTimer ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>))
  /** The preview forwards shown at the last check, to renew one as soon as it starts being shown. */
  let showing = new Set<string>()
  let pending: unknown, due: unknown, stopped = false
  // A daemon before #350 has no `ports.keep`; its preview forwards close when idle.
  const keep = (ids: string[]) => { if (ids.length) void deps.keep(ids).catch(() => {}) }
  const renewSoon = () => { if (due === undefined && !stopped && showing.size) due = setTimer(renew, every) }
  const renew = () => {
    due = undefined
    if (stopped) return
    showing = new Set(shownForwards(deps.forwards(), deps.uses()))
    keep([...showing])
    renewSoon()
  }
  const check = () => {
    pending = undefined
    if (stopped) return
    for (const threadId of deps.threads()) if (!deps.open(threadId)) deps.dispose(threadId)
    const shown = shownForwards(deps.forwards(), deps.uses())
    keep(shown.filter(id => !showing.has(id)))
    showing = new Set(shown)
    renewSoon()
  }
  const schedule = () => { if (pending === undefined && !stopped) pending = setTimer(check, 0) }
  const off = deps.subscribe(schedule)
  schedule()
  return () => {
    stopped = true; off()
    if (pending !== undefined) clearTimer(pending)
    if (due !== undefined) clearTimer(due)
  }
}
