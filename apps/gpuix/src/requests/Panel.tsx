import { motion } from '@gpuix/react'
import { useRef, useState, type ReactNode } from 'react'
import { EASE_OUT, REDUCED_MOTION } from '../ui.tsx'
// Keyboard answers must not animate the next card. The timestamp is consumed by
// its mount, not a timer or global event loop.
let answeredAt = 0
export function keyboardAnswer() { answeredAt = Date.now() }
export function PanelEnter({ children }: { children: ReactNode }) {
  const instant = Date.now() - answeredAt < 1200
  return <motion.div initial={instant ? false : { opacity: 0, top: REDUCED_MOTION ? 0 : 6 }} animate={{ opacity: 1, top: 0 }} transition={{ duration: instant ? 0 : .18, ease: EASE_OUT }} style={{ display: 'flex', flexDirection: 'column', position: 'relative' }}>{children}</motion.div>
}

/** Keep the last rendered panel for a short exit, then release its controls and
 * listeners. A keyboard answer removes it synchronously. No idle timer. */
export function PanelPresence({ show, children }: { show: boolean; children: ReactNode }) {
  const last = useRef<ReactNode>(null)
  const [present, setPresent] = useState(show)
  if (show) last.current = children
  if (show && !present) setPresent(true)
  const instant = Date.now() - answeredAt < 1200
  if (!show && instant && present) { last.current = null; setPresent(false) }
  if (!show && (!present || instant)) return null
  return <motion.div initial={false} animate={{ opacity: show ? 1 : 0, top: show || REDUCED_MOTION ? 0 : 3 }} transition={{ duration: show ? .18 : .12, ease: EASE_OUT }} onMotionComplete={() => { if (!show) { last.current = null; setPresent(false) } }} style={{ display: 'flex', flexDirection: 'column', position: 'relative', pointerEvents: show ? undefined : 'none' }}>{show ? children : last.current}</motion.div>
}
