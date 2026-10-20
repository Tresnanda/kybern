// A count that pops when it changes (`t-pop` keyed by the value; P0.10 `useCountPop`). The first render and rows recycled by a
// virtual list never pop; Reduce Motion and the stock addon show the number plainly (`popAnimation()` is `undefined`).
// `context` names what the count is counted over (a filter, a search): a count that changes because the context changed is a new
// view of the list, not a change to it, so it shows at once instead of popping every group at the same time.
import type { StyleDesc } from '@gpuix/react'
import { useRef } from 'react'
import { popAnimation } from '../kit/Pop.tsx'
import { Label } from '../ui.tsx'

export function CountPop({ value, context = '', color, size, lineHeight, weight, style }: { value: string | number; context?: string; color: string; size?: number; lineHeight?: number; weight?: number; style?: StyleDesc }) {
  const seen = useRef({ value, context })
  const pops = useRef(0)
  if (seen.current.value !== value || seen.current.context !== context) {
    if (seen.current.context === context) pops.current++
    seen.current = { value, context }
  }
  const key = pops.current
  return <Label key={key} color={color} size={size} lineHeight={lineHeight} weight={weight} style={style} paintAnimation={key ? popAnimation() : undefined}>{String(value)}</Label>
}
