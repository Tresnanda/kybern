import { N } from '../../nav/glyphs.ts'
import { Icon } from '../../icons.tsx'
import { COMPACT_CHIP } from '../PullsTabs.tsx'
import { Menu, MenuItem, MenuLabel, MenuSeparator } from '../../nav/overlay.tsx'
import { PickerChip } from '../../kit/PickerChip.tsx'
import { Label, useTheme } from '../../ui.tsx'
import { row } from '../../usage/controls.tsx'
import type { Project } from '../../../../../packages/kybern-client/src/types.ts'
import { isGroup, listableMembers, repoHue, toggleRepo, pickProject, type Scope } from './model.ts'
import { repoDot } from './parts.tsx'

/** The 16 px lead of a menu row: a check when it is chosen, so single and multiple choices line up. */
function Lead({ on, children }: { on: boolean; children?: React.ReactNode }) {
  const t = useTheme()
  return <div style={{ ...row, gap: 6, flexShrink: 0 }}>
    <div style={{ width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{on && <Icon source={N.check} size={14} color={t.link} />}</div>
    {children}
  </div>
}

/**
 * The header filter: All projects, then group projects with their repositories indented (several can be ticked), then
 * the single projects. `counts` are the open pull requests already loaded, by project id or `id/repo`; a number is
 * shown only where it is known.
 */
export function ProjectFilter({ projects, scope, remembered, onChange, counts, compact = false }: { projects: readonly Project[]; scope: Scope; remembered: Record<string, string[]>; onChange: (scope: Scope) => void; counts: ReadonlyMap<string, number>; /** A folder glyph instead of the name, when the header is too narrow to read it. */ compact?: boolean }) {
  const t = useTheme()
  const groups = projects.filter(isGroup)
  const singles = projects.filter(p => !isGroup(p))
  const current = projects.find(p => p.id === scope.project)
  const label = current ? current.name : 'All projects'
  const count = (key: string) => counts.get(key)
  return <Menu testId="pr-project-filter" align="start" width={264} {...(compact ? { rootStyle: { flexShrink: 0 } } : {})} trigger={open => compact
    ? <PickerChip size="sm" open={open} icon="folder" chevron={false} selected={!!current} quiet style={COMPACT_CHIP} label={`Project: ${label}`} />
    : <PickerChip size="sm" open={open} truncate maxWidth={150} label={`Project: ${label}`}>{label}</PickerChip>}>
    <MenuItem id="all" iconNode={<Lead on={!scope.project} />} label="All projects" onSelect={() => onChange(pickProject(null))} />
    {groups.length > 0 && <>
      <MenuSeparator />
      <MenuLabel>Group projects</MenuLabel>
      {groups.flatMap(g => [
        <MenuItem key={g.id} id={g.id} testId={`pr-filter-${g.id}`} iconNode={<Lead on={scope.project === g.id && scope.repos.length === 0} />} label={g.name} {...(count(g.id) !== undefined ? { detail: String(count(g.id)) } : {})} onSelect={() => onChange(pickProject(g, remembered[g.id]))} />,
        ...listableMembers(g).map(m => <MenuItem key={`${g.id}/${m.path}`} id={`${g.id}/${m.path}`} testId={`pr-filter-${g.id}-${m.path}`} keepOpen
          iconNode={<div style={{ ...row, gap: 6, paddingLeft: 14 }}><Lead on={scope.project === g.id && scope.repos.includes(m.path)}><div style={{ width: 6, height: 6, borderRadius: 3, flexShrink: 0, backgroundColor: repoDot(t, repoHue(`${g.id}/${m.path}`)) }} /></Lead></div>}
          label={m.name} {...(count(`${g.id}/${m.path}`) !== undefined ? { detail: String(count(`${g.id}/${m.path}`)) } : {})} onSelect={() => onChange(toggleRepo(scope, g, m.path))} />),
      ])}
    </>}
    {singles.length > 0 && <>
      <MenuSeparator />
      <MenuLabel>Projects</MenuLabel>
      {singles.map(p => <MenuItem key={p.id} id={p.id} testId={`pr-filter-${p.id}`} iconNode={<Lead on={scope.project === p.id} />} label={p.name} {...(count(p.id) !== undefined ? { detail: String(count(p.id)) } : {})} onSelect={() => onChange(pickProject(p))} />)}
    </>}
  </Menu>
}
