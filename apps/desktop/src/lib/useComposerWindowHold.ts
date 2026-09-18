import { useEffect, useState } from "react"

import { COMPOSER_WINDOW_HOLD_DELAY_MS, createComposerWindowHold } from "./composerWindowHold"

/** True after the window has been occluded/minimized/page-hidden for the delay.
 * Blur never sets this: visibilitychange is the only signal. */
export function useComposerWindowHold(delayMs = COMPOSER_WINDOW_HOLD_DELAY_MS): boolean {
  const [held, setHeld] = useState(false)
  useEffect(() => {
    if (typeof document === "undefined") return
    const hold = createComposerWindowHold({ delayMs })
    const stop = hold.subscribe(setHeld)
    hold.sync()
    const onVisibility = () => hold.sync()
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      document.removeEventListener("visibilitychange", onVisibility)
      stop()
      hold.dispose()
    }
  }, [delayMs])
  return held
}
