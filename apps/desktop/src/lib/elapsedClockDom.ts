// The app's single ElapsedClock, bound to timers and the window surface.

import { isWindowOnScreen, subscribeWindowSurface } from "@/state/windowSurfaceState"
import { createElapsedClock, type ElapsedClock } from "./elapsedClock"

let clock: ElapsedClock | undefined

export function elapsedClock(): ElapsedClock {
  if (clock) return clock
  const created = createElapsedClock({
    now: () => Date.now(),
    setTimer: (run, ms) => window.setTimeout(run, ms),
    clearTimer: (handle) => window.clearTimeout(handle as number),
    running: isWindowOnScreen,
  })
  document.addEventListener("visibilitychange", () => created.wake())
  subscribeWindowSurface(() => created.wake())
  clock = created
  return created
}
