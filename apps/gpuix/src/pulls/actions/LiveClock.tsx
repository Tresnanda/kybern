// A running run's or job's time that ticks once a second while it is painted (`useLoaderSecond`, the elapsed labels'
// visibility-aware seconds clock), in its own small island so a tick re-renders only the label. `format: 'clock'` reads
// `4:12` (a run's elapsed time in the list), `'duration'` reads `4m 12s` (a job or step). Information, not motion: it keeps
// counting under Reduce Motion.
import { clock, duration, seconds } from '../../../../../packages/kybern-client/src/actionsPipeline.ts'
import { ISLAND, useLoaderSecond } from '../../MatrixLoader.tsx'
import { useLoopVisibility } from '../../native/loop-visibility.ts'
import { Label } from '../../ui.tsx'

export function LiveClock({ since, format = 'duration', color, size = 12, lineHeight = 16, weight, prefix = '', testId }: {
  since: string | undefined; format?: 'clock' | 'duration'; color: string; size?: number; lineHeight?: number; weight?: number; prefix?: string; testId?: string
}) {
  const loop = useLoopVisibility(!!since)
  useLoaderSecond(loop.visible)
  const s = seconds(since, undefined)
  const text = s === null ? '' : format === 'clock' ? clock(s) : duration(s)
  return <div ref={loop.ref} testId={testId} {...ISLAND} style={{ display: 'flex', flexShrink: 0 }}>
    <Label color={color} size={size} lineHeight={lineHeight} weight={weight}>{`${prefix}${text}`}</Label>
  </div>
}
