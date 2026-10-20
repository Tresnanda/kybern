// A count that pops when it changes (`t-pop` keyed by the value; P0.10 `useCountPop`). The first render and rows recycled by a
// virtual list never pop; Reduce Motion and the stock addon show the number plainly (`popAnimation()` is `undefined`).
import type { StyleDesc } from '@gpuix/react'
import { popAnimation, useCountPop } from '../kit/Pop.tsx'
import { Label } from '../ui.tsx'

export function CountPop({ value, color, size, lineHeight, weight, style }: { value: string | number; color: string; size?: number; lineHeight?: number; weight?: number; style?: StyleDesc }) {
  const key = useCountPop(value)
  return <Label key={key} color={color} size={size} lineHeight={lineHeight} weight={weight} style={style} paintAnimation={key ? popAnimation() : undefined}>{String(value)}</Label>
}
