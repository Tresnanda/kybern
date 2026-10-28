// Small pieces of the pull request list: the repository badge, the readiness reason and the diff stat.
import {
  Alert02Icon, CancelCircleIcon, CheckmarkCircle02Icon, Clock01Icon, FlashIcon, GitMergeIcon, GitPullRequestClosedIcon,
  GitPullRequestDraftIcon, GitPullRequestIcon, Loading03Icon, MessageEdit01Icon,
} from '@hugeicons/core-free-icons'
import { glyph, Icon } from '../../icons.tsx'
import { RADIUS } from '../../kit/controls.ts'
import { Label, useTheme } from '../../ui.tsx'
import { row } from '../../usage/controls.tsx'
import type { Theme } from '../../theme.ts'
import type { RowReason } from '../../../../../packages/kybern-client/src/pullRequests.ts'
import { cachedProjectHue } from '../../../../../packages/kybern-client/src/projectColors.ts'
import { useApp } from '../../state.ts'
import { repoHue } from './model.ts'

const REASON_ICONS = {
  conflicts: glyph(GitMergeIcon),
  failing: glyph(CancelCircleIcon),
  changes: glyph(MessageEdit01Icon),
  warning: glyph(Alert02Icon),
  auto: glyph(FlashIcon),
  running: glyph(Loading03Icon),
  review: glyph(Clock01Icon),
  ready: glyph(CheckmarkCircle02Icon),
  draft: glyph(GitPullRequestDraftIcon),
  merged: glyph(GitMergeIcon),
  closed: glyph(GitPullRequestClosedIcon),
  open: glyph(GitPullRequestIcon),
}

/** The glyph for a reason label from `rowReason` ("2 failing", "6 running", "Changes requested", …). */
export function reasonGlyph(reason: RowReason): string {
  const label = reason.label
  if (label === 'Conflicts') return REASON_ICONS.conflicts
  if (/failing$/.test(label)) return REASON_ICONS.failing
  if (label === 'Changes requested') return REASON_ICONS.changes
  if (label === 'Behind' || label === 'Blocked') return REASON_ICONS.warning
  if (label === 'Auto-merge on') return REASON_ICONS.auto
  if (/running$/.test(label)) return REASON_ICONS.running
  if (label === 'Needs review') return REASON_ICONS.review
  if (label === 'Ready' || label === 'Approved') return REASON_ICONS.ready
  if (label === 'Draft') return REASON_ICONS.draft
  if (label === 'Merged') return REASON_ICONS.merged
  if (label === 'Closed') return REASON_ICONS.closed
  return REASON_ICONS.open
}

export function toneColor(t: Theme, tone: RowReason['tone']): string {
  switch (tone) {
    case 'danger': return t.red
    case 'warning': return t.warning
    case 'success': return t.green
    case 'info': return t.taskRun
    default: return t.textTertiary
  }
}

/** The dot colour for a hue: soft in both themes, like the project dot. */
export function repoDot(t: Theme, hue: number): string {
  const dark = t.variant === 'dark'
  return `oklch(${dark ? 0.74 : 0.62} ${dark ? 0.11 : 0.13} ${hue})`
}

/** A pull request's repository hue: the project's own colour, or for a group member one taken from its path (the filter menu's dot). */
export function useRepoHue(projectId: string, repo: string | undefined): number {
  const projects = useApp(s => s.projects)
  return repo ? repoHue(`${projectId}/${repo}`) : cachedProjectHue(projectId, projects)
}

/** A repository or project name with its hue dot: 18 high, radius 5, ink fill (the mockup's `.repo`). The list rows and the Summary heading share it. */
export function RepoBadge({ name, projectId, repo, maxWidth = 120, testId }: { name: string; projectId: string; repo?: string; maxWidth?: number; testId?: string }) {
  const t = useTheme()
  const hue = useRepoHue(projectId, repo)
  return <div testId={testId} style={{ ...row, gap: 5, height: 18, paddingLeft: 5, paddingRight: 6, borderRadius: RADIUS.xs, backgroundColor: t.variant === 'dark' ? 'rgba(252, 252, 252, 0.06)' : 'rgba(13, 13, 13, 0.06)', flexShrink: 1, maxWidth }}>
    <div style={{ width: 6, height: 6, borderRadius: 3, flexShrink: 0, backgroundColor: repoDot(t, hue) }} />
    <Label color={t.textSecondary} size={11.5} lineHeight={16} weight={500} truncate>{name}</Label>
  </div>
}

/** A 12 px tone glyph and a short reason; the label truncates before the glyph does. */
export function Reason({ reason, testId }: { reason: RowReason; testId?: string }) {
  const t = useTheme()
  return <div testId={testId} style={{ ...row, gap: 4, flexGrow: 1, flexShrink: 1 }}>
    <Icon source={reasonGlyph(reason)} size={12} color={toneColor(t, reason.tone)} style={{ flexShrink: 0 }} />
    <Label color={t.textSecondary} size={12} lineHeight={16} truncate>{reason.label}</Label>
  </div>
}

/** `+12 −3`, never clipped: it keeps its width while the reason and the badge give way. */
export function DiffStat({ additions, deletions }: { additions?: number; deletions?: number }) {
  const t = useTheme()
  if (additions === undefined && deletions === undefined) return null
  return <div style={{ ...row, gap: 4, flexShrink: 0 }}>
    <Label color={t.green} size={12} lineHeight={16}>{`+${(additions ?? 0).toLocaleString('en-US')}`}</Label>
    <Label color={t.red} size={12} lineHeight={16}>{`−${(deletions ?? 0).toLocaleString('en-US')}`}</Label>
  </div>
}
