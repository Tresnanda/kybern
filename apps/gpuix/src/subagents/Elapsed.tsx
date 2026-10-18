import { useLoopVisibility } from '../native/loop-visibility.ts'
import { formatElapsed } from '../../../../packages/kybern-client/src/subagents.ts'
import { ISLAND, useLoaderSecond } from '../MatrixLoader.tsx'
import { Label, useTheme } from '../ui.tsx'
export function Elapsed({ startedAt, endedAt, prefix = '' }: { startedAt: number; endedAt: number | null; prefix?: string }) {
  const loop = useLoopVisibility(endedAt === null)
  useLoaderSecond(loop.visible)
  const t = useTheme()
  return <div ref={loop.ref} {...ISLAND}><Label color={t.textTertiary} size={11}>{`${prefix}${formatElapsed((endedAt ?? Date.now()) - startedAt)}`}</Label></div>
}
