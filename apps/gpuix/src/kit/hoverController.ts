// The one place that decides whether a hover popup (tooltip, hover card) is visible.
//
// Why this exists (issue #108 R4-1): `@gpuix/react`'s `Tooltip` is controlled through
// `useControllableState`, whose `setValue` skips `onChange` when the *closure's* `open`
// already equals the next value. A tooltip that opens synchronously (the skip-delay path)
// and whose pointer leaves before React commits therefore saw `open === false`, dropped
// the close, and stayed on screen until the next hover. Fast sweeps down the rail left
// several of them. This controller keeps its state in plain fields (never read from a
// render closure), always applies a leave, and keeps at most one popup visible app-wide.
//
// Timings mirror Base UI: tooltips open after 600 ms and close at once; a tooltip that
// opens within 300 ms of another closing opens with no delay and no fade (`data-instant`).
// Cards (`PreviewCard`) default to 600 ms / 300 ms and stay open while the pointer is
// inside the popup; the sidebar cards on the desktop override the delays per use.

export interface Timers {
  set: (fn: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
  now: () => number
}

export const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => performance.now(),
}

/** Base UI's tooltip provider skip delay. */
export const TOOLTIP_SKIP_MS = 300
/** Base UI `Tooltip.Root` default delay. */
export const TOOLTIP_DELAY_MS = 600
/** Base UI `PreviewCard` defaults. */
export const CARD_DELAY_MS = 600
export const CARD_CLOSE_DELAY_MS = 300

export interface HoverOptions {
  /** Hover time before the popup opens. */
  delay: number
  /** Time the popup stays after the pointer leaves the trigger (0 closes at once). It stays open while the pointer is on the popup itself. */
  closeDelay?: number
  /** A popup opening within this long of any hover popup closing opens with no delay and no motion. 0 turns it off. */
  skip?: number
  /** The pointer may move onto the popup without closing it (cards). */
  hoverable?: boolean
  /** The popup this one sits inside (a tooltip in a card): opening it leaves that popup open. */
  parent?: HoverController<unknown> | null
}

/** Global state: the visible popup and when a popup last closed. */
const world: { current: HoverController<unknown> | null; lastClosedAt: number } = { current: null, lastClosedAt: Number.NEGATIVE_INFINITY }

/** The visible popup, if any (tests and diagnostics). */
export function visibleHoverPopup(): HoverController<unknown> | null {
  return world.current
}
export function resetHoverWorld() {
  world.current = null
  world.lastClosedAt = Number.NEGATIVE_INFINITY
}

function isAncestor(candidate: HoverController<unknown>, of: HoverController<unknown> | null | undefined): boolean {
  for (let node = of; node; node = node.options.parent) if (node === candidate) return true
  return false
}

export class HoverController<K = true> {
  /** What the popup is showing for (a ring, a row id), or null while closed. */
  active: K | null = null
  /** Opened right after another popup closed, or carried to the next trigger: skip the entrance motion. */
  instant = false
  /** Moved from one trigger to another while open (a shared card keeps its place). */
  carried = false
  private target: K | null = null
  private openTimer: unknown = null
  private closeTimer: unknown = null
  private overPopup = false
  constructor(
    /** Replaced by `useHover` on every render so a changed delay applies. */
    public options: HoverOptions,
    /** Called after every change of `active`, `instant` or `carried`. */
    private readonly notify: () => void,
    private readonly timers: Timers = realTimers,
  ) {}

  /** The pointer entered a trigger. */
  enter(key: K) {
    this.cancelClose()
    this.target = key
    if (this.active !== null) {
      // Already visible: move to this trigger without replaying anything.
      if (!Object.is(this.active, key)) {
        this.carried = true
        this.instant = true
        this.active = key
        this.notify()
      }
      return
    }
    this.cancelOpen()
    // GPUI may deliver the next trigger's enter before the previous trigger's leave: a popup
    // that is still visible counts as "just closed", so the hand-over is instant either way.
    const rival = world.current
    const neighbour = rival !== null && rival !== (this as unknown) && !isAncestor(rival, this.options.parent)
    const skip = this.options.skip ?? 0
    const skipped = skip > 0 && (neighbour || this.timers.now() - world.lastClosedAt <= skip)
    const delay = skipped ? 0 : this.options.delay
    if (delay <= 0) return this.show(key, skipped)
    this.openTimer = this.timers.set(() => {
      this.openTimer = null
      if (this.target !== null && Object.is(this.target, key)) this.show(key, false)
    }, delay)
  }

  /** The pointer left a trigger. Always applied, however soon after the enter. */
  leave() {
    this.target = null
    this.cancelOpen()
    this.scheduleClose()
  }

  /** The pointer entered the popup (hoverable cards only). */
  popupEnter() {
    if (!this.options.hoverable) return
    this.overPopup = true
    this.cancelClose()
  }

  popupLeave() {
    this.overPopup = false
    if (this.options.hoverable) this.scheduleClose()
  }

  /** Open now (keyboard focus). */
  openNow(key: K) {
    this.cancelClose()
    this.cancelOpen()
    this.target = key
    if (this.active === null || !Object.is(this.active, key)) this.show(key, false)
  }

  /** Close now (press, Escape, blur, unmount, or another popup opened). */
  hide() {
    this.target = null
    this.overPopup = false
    this.cancelOpen()
    this.cancelClose()
    if (this.active === null) return
    this.active = null
    this.instant = false
    this.carried = false
    world.lastClosedAt = this.timers.now()
    if (world.current === this) world.current = null
    this.notify()
  }

  dispose() {
    this.hide()
  }

  private show(key: K, instant: boolean) {
    const rival = world.current
    if (rival && rival !== (this as unknown) && !isAncestor(rival, this.options.parent)) {
      rival.hide()
      // The popup it replaced closed just now: this one takes its place without a fresh entrance.
      instant = instant || (this.options.skip ?? 0) > 0
    }
    world.current = this as unknown as HoverController<unknown>
    this.active = key
    this.instant = instant
    this.carried = false
    this.notify()
  }

  private scheduleClose() {
    this.cancelClose()
    const delay = this.options.closeDelay ?? 0
    if (delay <= 0 || this.active === null) return this.hide()
    this.closeTimer = this.timers.set(() => {
      this.closeTimer = null
      if (!this.overPopup && this.target === null) this.hide()
    }, delay)
  }

  private cancelOpen() {
    if (this.openTimer !== null) this.timers.clear(this.openTimer)
    this.openTimer = null
  }

  private cancelClose() {
    if (this.closeTimer !== null) this.timers.clear(this.closeTimer)
    this.closeTimer = null
  }
}
