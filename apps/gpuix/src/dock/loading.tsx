// Loading states for the dock (P3.7, P3.8): a skeleton that only appears if the wait is long enough to notice. A read that
// finishes inside `ms` never shows it (no flash, like the transcript's `chat-mount-loader-in` rule); a slow one fades in under a
// light sweep (`kit/Skeleton`, a compositor-friendly paint-only band) instead of a line of "Loading…" text.
import { useEffect, useState } from 'react'
import { Skeleton } from '../kit/Skeleton.tsx'
import { Spinner } from '../kit/Spinner.tsx'
import { Rise } from '../motion/kit.tsx'

/** The wait before a loading indicator shows (`--duration-quick`: shorter than that is not a wait). */
export const LOADING_DELAY_MS = 150

/** True once `on` has held for `ms`; false again as soon as it stops. One timer while pending, none after. */
export function useAfter(on: boolean, ms: number = LOADING_DELAY_MS): boolean {
  const [late, setLate] = useState(false)
  useEffect(() => {
    if (!on) { setLate(false); return }
    const timer = setTimeout(() => setLate(true), ms)
    return () => clearTimeout(timer)
  }, [on, ms])
  return on && late
}

const WIDTHS = ['62%', '88%', '74%', '93%', '48%', '81%', '67%'] as const

/** Skeleton lines for a file, diff or list that is still reading. Mount it only while loading; it shows itself after `delay` ms. */
export function LoadingLines({ lines = 6, delay = LOADING_DELAY_MS, testId = 'dock-loading' }: { lines?: number; delay?: number; testId?: string }) {
  const late = useAfter(true, delay)
  if (!late) return null
  return (
    <Rise kind="pane" style={{ padding: 12, gap: 10 }} testId={testId}>
      {Array.from({ length: lines }, (_, i) => <Skeleton key={i} width={WIDTHS[i % WIDTHS.length]} height={12} radius={6} />)}
    </Rise>
  )
}

/** A 12 px spinner that appears after `delay` ms of `on` (the chevron slot of a folder whose listing is loading). */
export function DelayedSpinner({ on, size = 12, color, delay = LOADING_DELAY_MS }: { on: boolean; size?: number; color?: string; delay?: number }) {
  const late = useAfter(on, delay)
  return late ? <Spinner size={size} color={color} /> : null
}
