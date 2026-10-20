// Composer motion on top of `src/motion/kit.tsx`: the desktop's swaps render
// their first paint without motion (`IconSwap` / `TextSwap` in
// `components/kybern/motion.tsx`), and attachment tiles `t-pop` in once.
import { type StyleDesc } from '@gpuix/react'
import { type ReactNode } from 'react'
import { popTransform } from '../kit/Pop.tsx'

// `IconSwap` / `TextSwap` for a state that flips after mount: the first state paints still, every later change (including the first)
// cross-swaps with the outgoing state kept for its exit. Pass `kind="icon"` for glyphs.
export { SwapOnChange } from '../motion/kit.tsx'

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
