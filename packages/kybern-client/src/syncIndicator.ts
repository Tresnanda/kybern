// A delayed "Syncing" indicator (#248): it appears only when a load takes longer
// than 400 ms, and once shown it stays at least 400 ms so it never flickers.
// Clients don't start it at all while a cached copy is on screen.

export const SYNC_INDICATOR_DELAY_MS = 400;
export const SYNC_INDICATOR_MIN_VISIBLE_MS = 400;

interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SyncIndicatorOptions {
  onChange: (visible: boolean) => void;
  showAfterMs?: number;
  minVisibleMs?: number;
  now?: () => number;
  timers?: Timers;
}

export interface SyncIndicator {
  /** A load began (idempotent while busy). */
  start(): void;
  /** The load finished or was abandoned. */
  stop(): void;
  readonly visible: boolean;
  /** Cancel timers; the indicator is hidden without notifying. */
  dispose(): void;
}

export function createSyncIndicator(options: SyncIndicatorOptions): SyncIndicator {
  const showAfter = options.showAfterMs ?? SYNC_INDICATOR_DELAY_MS;
  const minVisible = options.minVisibleMs ?? SYNC_INDICATOR_MIN_VISIBLE_MS;
  const now = options.now ?? Date.now;
  const timers: Timers = options.timers ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  let busy = false;
  let visible = false;
  let shownAt = 0;
  let showTimer: unknown;
  let hideTimer: unknown;

  const set = (next: boolean) => {
    if (visible === next) return;
    visible = next;
    if (next) shownAt = now();
    options.onChange(next);
  };
  const clearShow = () => {
    if (showTimer !== undefined) timers.clearTimeout(showTimer);
    showTimer = undefined;
  };
  const clearHide = () => {
    if (hideTimer !== undefined) timers.clearTimeout(hideTimer);
    hideTimer = undefined;
  };

  return {
    start() {
      if (busy) return;
      busy = true;
      clearHide();
      if (visible) return;
      showTimer = timers.setTimeout(() => {
        showTimer = undefined;
        if (busy) set(true);
      }, showAfter);
    },
    stop() {
      if (!busy) return;
      busy = false;
      clearShow();
      if (!visible) return;
      const left = shownAt + minVisible - now();
      if (left <= 0) {
        set(false);
        return;
      }
      hideTimer = timers.setTimeout(() => {
        hideTimer = undefined;
        if (!busy) set(false);
      }, left);
    },
    get visible() {
      return visible;
    },
    dispose() {
      clearShow();
      clearHide();
      busy = false;
      visible = false;
    },
  };
}
