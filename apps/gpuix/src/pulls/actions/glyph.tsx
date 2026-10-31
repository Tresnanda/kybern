// A run's, job's or step's mark: the pull request page's check glyphs in the same tones, plus a slashed ring for a cancelled
// run. Running is the still amber arc (a native spinner costs ~12% CPU each); colour never carries the state alone.
import { BUCKET_TONE, runBucket, type RunBucket } from '../../../../../packages/kybern-client/src/actions.ts'
import type { WorkflowRun } from '../../../../../packages/kybern-client/src/types.ts'
import { Icon } from '../../icons.tsx'
import { toneColor } from '../../kit/tone.ts'
import { useTheme } from '../../ui.tsx'
import { G } from '../detail/glyphs.ts'

const CANCELLED = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#000" stroke-width="1.4" stroke-linecap="round"><circle cx="8" cy="8" r="6.25"/><path d="M3.6 12.4l8.8-8.8"/></svg>`
export const BUCKET_GLYPH: Record<RunBucket, string> = { failed: G.xCircle, running: G.running, queued: G.queued, passed: G.checkCircle, skipped: G.skip, cancelled: CANCELLED }

export function bucketColor(t: ReturnType<typeof useTheme>, bucket: RunBucket) {
  return toneColor(t, BUCKET_TONE[bucket])
}

export function RunGlyph({ item, size = 14 }: { item: Pick<WorkflowRun, 'status' | 'conclusion'>; size?: number }) {
  const t = useTheme()
  const bucket = runBucket(item)
  return <Icon source={BUCKET_GLYPH[bucket]} size={size} color={bucketColor(t, bucket)} style={{ flexShrink: 0 }} />
}
