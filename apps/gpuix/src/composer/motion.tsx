// Composer motion on top of `src/motion/kit.tsx`: the desktop's swaps render
// their first paint without motion (`IconSwap` / `TextSwap` in
// `components/kybern/motion.tsx`), and attachment tiles `t-pop` in once.
import { motion, type StyleDesc } from '@gpuix/react'
import { useRef, type ReactNode } from 'react'
import { DURATION, DISTANCE, Swap } from '../motion/kit.tsx'
import { REDUCED_MOTION } from '../ui.tsx'

/** `--ease-bounce`. */
const EASE_BOUNCE: [number, number, number, number] = [0.34, 1.36, 0.64, 1]

/**
 * `IconSwap` / `TextSwap`: the first state paints still; every later change
 * fades the new state up in place over `--duration-fast`.
 */
export function SwapOnChange({ active, children, style }: { active: string; children: ReactNode; style?: StyleDesc }) {
  const first = useRef(active)
  const changed = useRef(false)
  if (active !== first.current) changed.current = true
  if (!changed.current) {
    return <div style={{ display: 'flex', position: 'relative', alignItems: 'center', justifyContent: 'center', ...style }}>{children}</div>
  }
  return (
    <Swap active={active} style={style}>
      {children}
    </Swap>
  )
}

/**
 * `t-pop` (`motion.css`): an added attachment comes in from 40% opacity over
 * `--duration-fast` on `--ease-bounce`. GPUIX has no scale, so the 0.85 → 1
 * growth becomes a 4px drift that overshoots a hair, like the bounce does.
 */
export function Pop({ children, style }: { children: ReactNode; style?: StyleDesc }) {
  return (
    <motion.div
      initial={{ opacity: 0.4, top: REDUCED_MOTION ? 0 : DISTANCE.micro }}
      animate={{ opacity: 1, top: 0 }}
      transition={{ duration: DURATION.fast, ease: EASE_BOUNCE }}
      style={{ display: 'flex', position: 'relative', flexShrink: 0, ...style }}
    >
      {children}
    </motion.div>
  )
}
