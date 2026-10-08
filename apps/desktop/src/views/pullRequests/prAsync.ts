import { useEffect, useState } from "react"

/** True only after `active` has held for `delay` ms, so quick refreshes never flash a spinner. */
export function useDelayedFlag(active: boolean, delay = 400): boolean {
  const [elapsed, setElapsed] = useState(false)
  useEffect(() => {
    if (!active) return
    const id = window.setTimeout(() => setElapsed(true), delay)
    return () => {
      window.clearTimeout(id)
      setElapsed(false)
    }
  }, [active, delay])
  return active && elapsed
}
