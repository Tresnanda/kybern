// The daemon updates an earlier Cursor SDK in the background and tells no client when it is done, so the provider list keeps
// saying "Updating Cursor's SDK…". One poller per connection follows `cursor.status` while Cursor is updating, then reloads the
// provider list and catalogs once. Only an updating Cursor starts it; it sleeps while the window is hidden and gives up
// after ten minutes.
import type { CursorSetupStatus, ProviderStatus } from '../../../../packages/kybern-client/src/types.ts'

export const CURSOR_UPDATE_POLL_MS = 4_000
export const CURSOR_UPDATE_GIVE_UP_MS = 10 * 60_000

/** The provider entry says the SDK is being updated (`Updating Cursor’s SDK from … to …`, the daemon's `runtime.rs`). */
export const cursorIsUpdating = (providers: readonly ProviderStatus[]) => {
  const cursor = providers.find((p) => p.kind === 'cursor')
  return !!cursor && !cursor.available && /^Updating Cursor.s SDK/.test(cursor.unavailable_reason ?? '')
}

export interface CursorUpdateDeps {
  status: () => Promise<Pick<CursorSetupStatus, 'installing'>>
  /** Reload the provider list and catalogs everywhere they are shown. */
  reload: () => void
  isVisible: () => boolean
  onVisibility: (listener: (visible: boolean) => void) => () => void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (id: unknown) => void
}

export interface CursorUpdateFollower {
  /** Feed the latest provider list: an updating Cursor starts polling (once), anything else leaves it as it is. */
  observe(providers: readonly ProviderStatus[]): void
  polling(): boolean
  stop(): void
}

export function followCursorUpdate(deps: CursorUpdateDeps): CursorUpdateFollower {
  const now = deps.now ?? Date.now
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>))
  let active = false
  let timer: unknown
  let deadline = 0
  let inFlight = false
  let stopVisibility: (() => void) | undefined

  const clear = () => { if (timer !== undefined) clearTimer(timer); timer = undefined }
  const finish = () => { active = false; clear(); stopVisibility?.(); stopVisibility = undefined }
  const schedule = () => {
    clear()
    if (!active || !deps.isVisible()) return
    timer = setTimer(() => { timer = undefined; void tick() }, CURSOR_UPDATE_POLL_MS)
  }
  async function tick() {
    if (!active || inFlight) return
    if (now() >= deadline) { finish(); return }
    inFlight = true
    let done = false
    try { done = !(await deps.status()).installing } catch { /* the next tick tries again */ }
    inFlight = false
    if (!active) return
    if (done) { finish(); deps.reload(); return }
    schedule()
  }

  return {
    observe(providers) {
      if (active || !cursorIsUpdating(providers)) return
      active = true
      deadline = now() + CURSOR_UPDATE_GIVE_UP_MS
      stopVisibility = deps.onVisibility((visible) => { if (!visible) clear(); else if (active && timer === undefined && !inFlight) void tick() })
      schedule()
    },
    polling: () => active,
    stop: finish,
  }
}
