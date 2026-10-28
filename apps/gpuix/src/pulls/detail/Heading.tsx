// The Summary heading: repo badge · #n · state pill on one line, the title, then who wants to merge what into where. The project and
// the branch pair are not repeated (the list header already names the project).
import { Icon } from '../../icons.tsx'
import { N } from '../../nav/glyphs.ts'
import { Avatar } from '../../kit/Avatar.tsx'
import { SwapOnChange } from '../../motion/kit.tsx'
import { popTransform, useCountPop } from '../../kit/Pop.tsx'
import { cachedProjectHue } from '../../../../../packages/kybern-client/src/projectColors.ts'
import type { PrDetailResult } from '../../../../../packages/kybern-client/src/types.ts'
import { useApp } from '../../state.ts'
import { FONT_MONO } from '../../theme.ts'
import { alpha } from '../../transcript/kit.tsx'
import { Label, ink, useTheme } from '../../ui.tsx'
import { column, row } from '../../usage/controls.tsx'
import { agoPhrase } from '@/views/pullRequests/prFormat'
import { wantsToMerge } from './model.ts'

/** The repository as a chip: a dot in the project's hue and its name (the list rows will carry the same). */
function RepoTag({ projectId, name }: { projectId: string; name: string }) {
  const t = useTheme()
  const projects = useApp(s => s.projects)
  const hue = cachedProjectHue(projectId, projects)
  const dark = t.variant === 'dark'
  return <div testId="pr-repo" style={{ ...row, gap: 5, height: 20, paddingLeft: 5, paddingRight: 6, borderRadius: 5, backgroundColor: ink(t, dark ? 0.06 : 0.05), flexShrink: 1 }}><div style={{ width: 6, height: 6, borderRadius: 3, flexShrink: 0, backgroundColor: `oklch(${dark ? 0.74 : 0.62} ${dark ? 0.11 : 0.13} ${hue})` }} /><Label color={t.textSecondary} size={11.5} lineHeight={16} weight={500} truncate>{name}</Label></div>
}

/** The state pill. When the state changes after the pull request opened (a merge), the label swaps and the pill pops (`t-pop`, once). */
export function StatePill({ pr }: { pr: PrDetailResult['pull_request'] }) {
  const t = useTheme()
  const open = pr.state === 'OPEN' && !pr.is_draft
  const label = pr.is_draft ? 'Draft' : pr.state === 'OPEN' ? 'Open' : pr.state === 'MERGED' ? 'Merged' : 'Closed'
  const pops = useCountPop(label)
  const pop = pops ? popTransform() : undefined
  const paint = pop ? { ...pop, generation: pops } : { initial: false as const, animate: { scale: 1, opacity: 1 }, transition: { duration: 0 }, generation: 0 }
  const color = open ? t.green : pr.state === 'MERGED' ? t.link : t.textSecondary
  return <div testId="pr-state-pill" paintTransform={paint} style={{ ...row, gap: 4, height: 20, borderRadius: 6, paddingLeft: 5, paddingRight: 7, backgroundColor: open ? alpha(t.green, 0.12) : pr.state === 'MERGED' ? alpha(t.link, 0.12) : ink(t, 0.07) }}><Icon source={N.pullRequest} size={13} color={color} /><SwapOnChange active={label} style={{ justifyContent: 'flex-start' }}><Label color={color} size={12} lineHeight={16} weight={500}>{label}</Label></SwapOnChange></div>
}

function Branch({ name }: { name: string }) {
  const t = useTheme()
  return <div style={{ ...row, height: 20, paddingLeft: 6, paddingRight: 6, borderRadius: 5, backgroundColor: ink(t, t.variant === 'dark' ? 0.06 : 0.05), flexShrink: 1 }}><Label color={t.text} size={12} lineHeight={16} font={FONT_MONO} truncate>{name}</Label></div>
}

export function Heading({ detail, projectId, repoName, compact }: { detail: PrDetailResult; projectId: string; repoName: string; compact: boolean }) {
  const t = useTheme()
  const p = detail.pull_request
  return (
    <div testId="pr-heading" style={{ ...column, gap: 10 }}>
      <div style={{ ...row, gap: 8 }}>
        <RepoTag projectId={projectId} name={repoName} />
        <Label color={t.textSecondary} size={12.5} lineHeight={18}>{`#${p.number}`}</Label>
        <Label color={t.textTertiary} size={12.5} lineHeight={18}>·</Label>
        <StatePill pr={p} />
      </div>
      <Label color={t.text} size={compact ? 20 : 22} lineHeight={compact ? 26 : 28} weight={600}>{p.title}</Label>
      <div style={{ ...row, flexWrap: 'wrap', gap: 6, rowGap: 4 }}>
        <Avatar login={p.author} url={p.author_avatar_url} size={compact ? 18 : 20} />
        <Label color={t.text} size={13} lineHeight={20} weight={500}>{p.author}</Label>
        <Label color={t.textSecondary} size={13} lineHeight={20}>{wantsToMerge(p.state, detail.timeline_counts?.commits)}</Label>
        <Branch name={p.base} />
        <Label color={t.textSecondary} size={13} lineHeight={20}>from</Label>
        <Branch name={p.head} />
        <Label color={t.textSecondary} size={13} lineHeight={20}>{`· ${agoPhrase(p.created_at ?? p.updated_at)}`}</Label>
      </div>
    </div>
  )
}
