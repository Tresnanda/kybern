// Composer motion on top of `src/motion/kit.tsx`: the desktop's swaps render
// their first paint without motion (`IconSwap` / `TextSwap` in
// `components/kybern/motion.tsx`), and attachment tiles `t-pop` in once.
import { type StyleDesc } from '@gpuix/react'
import { useRef, type ReactNode } from 'react'
import { popTransform } from '../kit/Pop.tsx'
import { Swap } from '../motion/kit.tsx'

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
 * `t-pop` (`motion.css`): an added attachment tile scales 0.85 -> 1 and fades in from 40% over `--duration-fast` on
 * `--ease-bounce`, as a whole box (`kit/Pop.tsx` `popTransform`, paint-only). Reduce Motion shows it at once.
 */
export function Pop({ children, style }: { children: ReactNode; style?: StyleDesc }) {
  return (
    <div paintTransform={popTransform()} style={{ display: 'flex', position: 'relative', flexShrink: 0, ...style }}>
      {children}
    </div>
  )
}
