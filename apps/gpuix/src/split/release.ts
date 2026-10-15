type PointerState = { pressed: boolean; active: boolean }

/** Only physical gestures arm this fallback; native automation owns its own up.
 * Element mouse-up gets 100ms to commit before a missed release cancels instead.
 * The timer exists only while a physical gesture is in progress.
 */
export function watchPointerRelease(read: () => PointerState, cancel: () => void): () => void {
  const initial = read()
  if (!initial.pressed) return () => {}
  let releasedAt: number | null = null
  const timer = setInterval(() => {
    const next = read()
    if (next.pressed) releasedAt = null
    else releasedAt ??= Date.now()
    if ((initial.active && !next.active) || (releasedAt !== null && Date.now() - releasedAt >= 100)) {
      clearInterval(timer)
      cancel()
    }
  }, 32)
  return () => clearInterval(timer)
}
