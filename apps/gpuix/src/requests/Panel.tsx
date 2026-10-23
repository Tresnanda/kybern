import { useState, type ReactNode } from 'react'
import { EASE } from '../motion/kit.tsx'
import { Presence } from '../motion/Presence.tsx'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { REDUCED_MOTION } from '../ui.tsx'
// Keyboard answers must not animate the next card. The timestamp is consumed by
// its mount, not a timer or global event loop.
let answeredAt = 0
export function keyboardAnswer() { answeredAt = Date.now() }
const instantNow = () => Date.now() - answeredAt < 1200

/**
 * A request card rising into the stack (`t-panel-enter`, kept at 180 ms: snappier than the desktop's 350 ms on purpose): 6 px low,
 * faint and 2 px blurred → rest, painted natively (`paintTransform`, no layout per frame). A keyboard answer shows the next card at
 * once; Reduce Motion fades. Decided on mount, so a keyboard answer a moment later does not cut a running entrance.
 */
export function PanelEnter({ children, always = false }: { children: ReactNode; /** Rise in even after a keyboard answer (the password prompt). */ always?: boolean }) {
  const [transform] = useState(() => !PATCHED_NATIVE || (instantNow() && !always) ? undefined : REDUCED_MOTION
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: 0.18, ease: [...EASE.out] as [number, number, number, number] } }
    : { initial: { opacity: 0, translateY: 6, blur: 2 }, animate: { opacity: 1, translateY: 0, blur: 0 }, transition: { duration: 0.18, ease: [...EASE.out] as [number, number, number, number] } })
  return <div paintTransform={transform} style={{ display: 'flex', flexDirection: 'column', width: '100%', position: 'relative' }}>{children}</div>
}

/** Keep the last rendered panel for a short exit (120 ms, fade and 3 px drop), then release its controls and
 * listeners. A keyboard answer removes it synchronously. No idle timer, no layout per frame. */
export function PanelPresence({ show, children }: { show: boolean; children: ReactNode }) {
  return (
    <Presence show={show} exit={{ to: { opacity: 0, translateY: 3 }, duration: instantNow() ? 0 : 0.12, ease: EASE.out }} style={{ width: '100%', position: 'relative' }}>
      {children}
    </Presence>
  )
}
