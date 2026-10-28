// The new chat's tray for a group project (L3 sheet 5). The branch chip reads "main +2": the primary repository's branch
// plus how many other repositories the chat spans; its menu lists every repository with its branch, and each one's
// submenu picks that repository's branch (local: the checkout switches to it when the chat starts; worktree: the fork
// point). In worktree mode a third chip picks the repositories the chat gets (all by default; the last one can't be
// unticked). The choices live in the draft (`draft.group`) and reach `threads.create` as `members` / `base_branches`.
import { homedir } from 'node:os'
import { useEffect, useState } from 'react'
import {
  GROUP_COPY,
  branchChipLabel,
  deselectedNote,
  memberMissingLabel,
  reposChipLabel,
  uncommittedHint,
  worktreeBranchCaption,
} from '../../../../packages/kybern-client/src/groups.ts'
import type { GitBranchesResult, Project } from '../../../../packages/kybern-client/src/types.ts'
import { Checkbox } from '../kit/Checkbox.tsx'
import { PickerChip } from '../kit/PickerChip.tsx'
import { tildify } from '../groups/model.ts'
import { loadMemberStatus, useMemberStatus } from '../groups/store.ts'
import { availableMembers, branchOf, choiceFor, includedMembers, toggleMember, type GroupChoice } from '../groups/tray.ts'
import { Icon } from '../icons.tsx'
import { N } from '../nav/glyphs.ts'
import { Menu, MenuItem, MenuLabel, MenuSeparator, MenuSub } from '../nav/overlay.tsx'
import { activeEnvironment } from '../shell/environment.ts'
import { projectClient } from '../state.ts'
import { FONT_MONO } from '../theme.ts'
import { Label, useTheme } from '../ui.tsx'
import { G } from './glyphs.ts'
import { muted, PickerItem, PickerLabel, PickerMenu } from './Menu.tsx'
import { patchDraft, useComposer } from './store.ts'

/** The draft's group choice for this project (a fresh one when the draft holds another project's). */
export function useGroupChoice(projectId: string): GroupChoice {
  const stored = useComposer((d) => d.draft.group)
  return choiceFor(stored, projectId)
}

const setChoice = (choice: GroupChoice) => patchDraft({ group: choice })

/** Load the members' branches and dirty counts once the tray shows a group. */
export function useGroupStatus(projectId: string, still: boolean) {
  useEffect(() => { if (!still) void loadMemberStatus(projectId) }, [projectId, still])
  return useMemberStatus(projectId)
}

export function GroupBranchChip({ project, useWorktree, still = false }: { project: Project; useWorktree: boolean; still?: boolean }) {
  const t = useTheme()
  const status = useGroupStatus(project.id, still)
  const choice = useGroupChoice(project.id)
  const included = includedMembers(project, choice, useWorktree)
  const primary = included[0]
  const missing = (project.members ?? []).filter((m) => m.status !== 'ok')
  const { label, extra } = branchChipLabel(primary ? branchOf(choice, primary.path, status?.members) : null, included.length - 1)
  const folder = activeEnvironment().local ? tildify(project.path, homedir()) : project.path
  return (
    <Menu
      testId="tray-branch"
      side="top"
      align="start"
      sideOffset={8}
      width={300}
      trigger={(open) => (
        // A repository missing on disk turns the count to the warning colour; its row in the menu says where it went.
        missing.length && extra ? (
          <PickerChip bare icon={G.branch} open={open} truncate maxWidth={256} label={`${label} ${extra}`}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              <Label color={t.text} size={13} lineHeight={18} weight={500} truncate>{label}</Label>
              <Label color={t.warning} size={13} lineHeight={18} weight={500}>{extra}</Label>
            </div>
          </PickerChip>
        ) : (
          <PickerChip bare icon={G.branch} open={open} truncate maxWidth={256} secondary={extra}>{label}</PickerChip>
        )
      )}
    >
      <MenuLabel>{useWorktree ? GROUP_COPY.branchMenuWorktreeTitle : GROUP_COPY.branchMenuTitle}</MenuLabel>
      {included.map((member, i) => {
        const branch = branchOf(choice, member.path, status?.members)
        return (
          <MenuSub
            key={member.path}
            id={`repo:${member.path}`}
            testId={`tray-branch-repo-${member.path}`}
            icon={N.repo}
            label={member.name}
            hint={i === 0 ? GROUP_COPY.primary.toLowerCase() : undefined}
            width={232}
            maxHeight={320}
            trailing={branch ? <><Icon source={G.branch} size={12} color={muted(t, 0.6)} /><Label color={muted(t, 0.7)} size={12} truncate>{branch}</Label></> : undefined}
          >
            <BranchList project={project} repo={member.path} selected={branch} onPick={(name) => setChoice({ ...choice, baseBranches: { ...choice.baseBranches, [member.path]: name } })} />
          </MenuSub>
        )
      })}
      {missing.map((member) => (
        <MenuItem key={member.path} id={`missing:${member.path}`} icon={N.alert} label={member.name} description={memberMissingLabel(folder)} disabled onSelect={() => {}} />
      ))}
      <MenuSeparator />
      <div style={{ display: 'flex', flexDirection: 'column', paddingLeft: 8, paddingRight: 8, paddingTop: 2, paddingBottom: 4 }}>
        <Label color={muted(t, 0.6)} size={12} lineHeight={16} style={{ maxWidth: 276 }}>{useWorktree ? worktreeBranchCaption('a new kybern/ branch') : GROUP_COPY.branchMenuLocalCaption}</Label>
      </div>
    </Menu>
  )
}

/** One repository's branches (`git.branches { repo }`), loaded when its submenu opens. */
function BranchList({ project, repo, selected, onPick }: { project: Project; repo: string; selected: string | null; onPick: (name: string) => void }) {
  const t = useTheme()
  const [branches, setBranches] = useState<GitBranchesResult | null>(null)
  useEffect(() => {
    const client = projectClient(project.id)
    if (!client) return
    let live = true
    client.call('git.branches', { project_id: project.id, repo }).then((result) => { if (live) setBranches(result) }, () => { if (live) setBranches({ current: null, branches: [] }) })
    return () => { live = false }
  }, [project.id, repo])
  if (!branches) return <div style={{ display: 'flex', paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4 }}><Label color={t.textSecondary} size={13}>Loading branches…</Label></div>
  if (!branches.branches.length) return <div style={{ display: 'flex', paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4 }}><Label color={t.textSecondary} size={13}>No branches yet. Make a first commit.</Label></div>
  return (
    <>
      {branches.branches.map((b) => (
        <MenuItem key={b.name} id={`branch:${b.name}`} testId={`tray-branch-${repo}-${b.name}`} label={b.name} detail={b.is_current ? 'current' : undefined} checked={(selected ?? branches.current) === b.name} onSelect={() => onPick(b.name)} />
      ))}
    </>
  )
}

/** Worktree mode: which repositories this chat gets. */
export function ReposChip({ project, still = false }: { project: Project; still?: boolean }) {
  const t = useTheme()
  const status = useGroupStatus(project.id, still)
  const choice = useGroupChoice(project.id)
  const available = availableMembers(project)
  const included = includedMembers(project, choice, true)
  const deselected = available.filter((m) => !included.includes(m))
  const absolute = (path: string) => (path === '.' ? project.path : `${project.path}/${path}`)
  const local = activeEnvironment().local
  const footer = included.length === 1 && available.length > 1 ? GROUP_COPY.lastRepository
    : deselected.length ? deselectedNote(deselected, (m) => (local ? tildify(absolute(m.path), homedir()) : absolute(m.path)))
    : GROUP_COPY.reposMenuFooter
  return (
    <PickerMenu
      testId="tray-repos"
      side="top"
      align="start"
      sideOffset={8}
      width={300}
      trigger={(open) => <PickerChip bare icon={N.repo} open={open} truncate maxWidth={200}>{reposChipLabel(included.map((m) => m.name), available.length)}</PickerChip>}
    >
      <PickerLabel>{GROUP_COPY.reposMenuTitle}</PickerLabel>
      {available.map((member) => {
        const on = included.includes(member)
        const last = on && included.length === 1
        const dirty = uncommittedHint(status?.members.find((m) => m.path === member.path)?.dirty_files ?? 0)
        const branch = branchOf(choice, member.path, status?.members)
        return (
          <PickerItem key={member.path} id={member.path} testId={`tray-repos-${member.path}`} keepOpen disabled={last} onSelect={() => setChoice(toggleMember(project, choice, member.path))} style={{ alignItems: 'flex-start', paddingTop: 5, paddingBottom: 5, opacity: 1 }}>
            <div style={{ display: 'flex', paddingTop: 2 }}><Checkbox checked={on} disabled={last} aria-label={member.name} style={{ pointerEvents: 'none' }} /></div>
            <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 }}>
              <Label color={t.text} lineHeight={20} truncate>{member.name}</Label>
              {dirty && <Label color={muted(t, 0.6)} size={12} lineHeight={16}>{dirty}</Label>}
            </div>
            {branch && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, maxWidth: 120, paddingTop: 2 }}>
                <Icon source={G.branch} size={12} color={muted(t, 0.6)} />
                <Label color={muted(t, 0.7)} size={12} lineHeight={16} font={status?.members.find((m) => m.path === member.path)?.detached ? FONT_MONO : undefined} truncate>{branch}</Label>
              </div>
            )}
          </PickerItem>
        )
      })}
      <div style={{ display: 'flex', flexDirection: 'column', paddingLeft: 8, paddingRight: 8, paddingTop: 6, paddingBottom: 4 }}>
        <Label color={muted(t, 0.6)} size={12} lineHeight={16} style={{ maxWidth: 276 }}>{footer}</Label>
      </div>
    </PickerMenu>
  )
}
