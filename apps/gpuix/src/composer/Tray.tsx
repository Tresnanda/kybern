// The home screen's tray docked on the composer (`LandingTray` in
// `views/Composer.tsx`, chips in `views/trayChips.tsx`, wiring in
// `views/Draft.tsx`): the project (or Free chat), Checkout / New worktree, and
// the branch to start from. Menus open upward, 8px from the chip.
import { useEffect } from 'react'
import { Icon } from '../icons.tsx'
import { Label, useTheme } from '../ui.tsx'
import type { Project, ProjectId } from '../../../../packages/kybern-client/src/types.ts'
import { useApp } from '../state.ts'
import { TrayChip } from './chips.tsx'
import { G } from './glyphs.ts'
import { CheckMark, muted, PickerItem, PickerLabel, PickerMenu, PickerSeparator } from './Menu.tsx'
import { loadBranches, patchDraft, useComposer } from './store.ts'

export const COMPOSER_RADIUS = 19.2

/** `parentPath` in `views/Draft.tsx`: `…/projects` for the checkout hint. */
function parentPath(p: string): string {
  const i = p.lastIndexOf('/')
  return i <= 0 ? p : '…/' + p.slice(p.slice(0, i).lastIndexOf('/') + 1, i)
}

export function LandingTray({ projectId, useWorktree }: { projectId: ProjectId | null; useWorktree: boolean }) {
  const t = useTheme()
  const projects = useApp((s) => s.projects)
  const project = projectId ? projects.find((p) => p.id === projectId) : undefined
  const list = [...projects].sort((a, b) => a.name.localeCompare(b.name))
  const isGit = project?.is_git ?? false
  useEffect(() => {
    if (projectId && isGit) void loadBranches(projectId)
  }, [projectId, isGit])
  // `--composer-backing-surface` (`kybern.css:12`, the light mix in `theme.logic`).
  const backing = t.variant === 'dark' ? '#222222' : t.v('--composer-backing-surface')
  return (
    <div
      testId="landing-tray"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        width: '93.33%',
        minHeight: 28,
        minWidth: 0,
        paddingLeft: 8,
        paddingRight: 8,
        paddingTop: 4,
        paddingBottom: 4,
        borderTopLeftRadius: COMPOSER_RADIUS,
        borderTopRightRadius: COMPOSER_RADIUS,
        backgroundColor: backing,
      }}
    >
      {project ? (
        <ProjectChip projectId={project.id} projects={list} />
      ) : (
        <FreeChatChip projects={list} />
      )}
      {project && <WorkspaceChip useWorktree={useWorktree} isGit={isGit} checkoutHint={parentPath(project.path)} />}
      {project && isGit && <BranchChip projectId={project.id} useWorktree={useWorktree} />}
    </div>
  )
}

/** `ProjectTrayChip`, plus the Free chat choice of the Free chat chip's menu (a Coordinator always has a project). */
function ProjectChip({ projectId, projects }: { projectId: ProjectId; projects: Project[] }) {
  const t = useTheme()
  const current = projects.find((p) => p.id === projectId)
  const coordinator = useApp((s) => s.draft.purpose === 'coordinator')
  return (
    <PickerMenu
      testId="tray-project"
      side="top"
      align="start"
      sideOffset={8}
      minWidth={224}
      trigger={(open) => <TrayChip icon={G.folder} label={current?.name ?? 'Choose a project'} pressed={open} strong={!current} />}
    >
      <PickerLabel>{coordinator ? 'Project' : 'Chat location'}</PickerLabel>
      {!coordinator && (
        <PickerItem id="free" onSelect={() => patchDraft({ projectId: null, worktree: null, baseBranch: null })}>
          <Icon source={G.message} size={18} color={t.text} style={{ opacity: 0.8 }} />
          <Label color={t.text} truncate style={{ flexGrow: 1 }}>
            Free chat
          </Label>
        </PickerItem>
      )}
      {projects.map((p) => (
        <PickerItem key={p.id} id={p.id} onSelect={() => patchDraft({ projectId: p.id, worktree: null, baseBranch: null })}>
          <Icon name="folder" size={18} color={t.text} style={{ opacity: 0.8 }} />
          <Label color={t.text} truncate style={{ flexGrow: 1 }}>
            {p.name}
          </Label>
          {p.id === projectId && <Icon source={G.checkBold} size={14} color={t.text} />}
        </PickerItem>
      ))}
    </PickerMenu>
  )
}

/** The Free chat chip and its "Chat location" menu (`views/Draft.tsx:180-226`). */
function FreeChatChip({ projects }: { projects: Project[] }) {
  const t = useTheme()
  return (
    <PickerMenu
      testId="tray-project"
      side="top"
      align="start"
      sideOffset={8}
      minWidth={256}
      trigger={(open) => <TrayChip icon={G.message} label="Free chat" strong pressed={open} />}
    >
      <PickerLabel>Chat location</PickerLabel>
      <PickerItem id="free" onSelect={() => {}}>
        <Icon source={G.message} size={14} color={t.text} />
        <Label color={t.text} truncate style={{ flexGrow: 1 }}>
          Free chat
        </Label>
        <CheckMark color={t.text} />
      </PickerItem>
      {projects.map((p) => (
        <PickerItem key={p.id} id={p.id} onSelect={() => patchDraft({ projectId: p.id, worktree: null, baseBranch: null })}>
          <Icon name="folder" size={14} color={t.text} />
          <Label color={t.text} truncate style={{ flexGrow: 1 }}>
            {p.name}
          </Label>
          <CheckMark color={t.text} visible={false} />
        </PickerItem>
      ))}
    </PickerMenu>
  )
}

/** `WorkspaceTrayChip`: Checkout or a new worktree. */
function WorkspaceChip({ useWorktree, isGit, checkoutHint }: { useWorktree: boolean; isGit: boolean; checkoutHint: string }) {
  const t = useTheme()
  return (
    <PickerMenu
      testId="tray-workspace"
      side="top"
      align="start"
      sideOffset={8}
      width={256}
      trigger={(open) => (
        <TrayChip icon={useWorktree ? G.worktree : G.laptop} label={useWorktree ? 'New worktree' : 'Checkout'} strong={useWorktree} pressed={open} />
      )}
    >
      <PickerLabel>Run in</PickerLabel>
      <PickerItem id="local" onSelect={() => patchDraft({ worktree: false })}>
        <Icon source={G.laptop} size={14} color={t.text} />
        <Label color={t.text} truncate style={{ flexGrow: 1 }}>
          Checkout
        </Label>
        <Label color={muted(t, 0.7)} style={{ flexShrink: 0 }}>
          {checkoutHint}
        </Label>
        <CheckMark color={t.text} visible={!useWorktree} />
      </PickerItem>
      <PickerItem id="worktree" disabled={!isGit} onSelect={() => patchDraft({ worktree: true })}>
        <Icon source={G.worktree} size={14} color={t.text} />
        <Label color={t.text} truncate style={{ flexGrow: 1 }}>
          New worktree
        </Label>
        {!isGit && (
          <Label color={muted(t, 0.7)} style={{ flexShrink: 0 }}>
            Needs git
          </Label>
        )}
        <CheckMark color={t.text} visible={useWorktree} />
      </PickerItem>
    </PickerMenu>
  )
}

/** `BranchTrayChip`: the branch to start from, and a worktree toggle. */
function BranchChip({ projectId, useWorktree }: { projectId: ProjectId; useWorktree: boolean }) {
  const t = useTheme()
  const branches = useComposer((d) => (d.branches?.projectId === projectId ? d.branches.result : null))
  const baseBranch = useComposer((d) => d.draft.baseBranch)
  const shown = baseBranch ?? branches?.current ?? 'Current branch'
  return (
    <PickerMenu
      testId="tray-branch"
      side="top"
      align="start"
      sideOffset={8}
      width={288}
      onOpenChange={(open) => open && void loadBranches(projectId)}
      trigger={(open) => <TrayChip icon={G.branch} label={shown} strong={!!baseBranch} pressed={open} />}
    >
      <PickerLabel>{useWorktree ? 'Fork the worktree from' : 'Branch'}</PickerLabel>
      {branches === null ? (
        <PickerItem id="__loading" disabled onSelect={() => {}}>
          <Label color={t.textSecondary}>Loading branches…</Label>
        </PickerItem>
      ) : branches.branches.length === 0 ? (
        <PickerItem id="__empty" disabled onSelect={() => {}}>
          <Label color={t.textSecondary}>No branches yet. Make a first commit.</Label>
        </PickerItem>
      ) : (
        branches.branches.map((b) => (
          <PickerItem key={b.name} id={`branch:${b.name}`} onSelect={() => patchDraft({ baseBranch: b.name === branches.current ? null : b.name })}>
            <Icon source={G.branch} size={14} color={t.text} />
            <Label color={t.text} truncate style={{ flexGrow: 1 }}>
              {b.name}
            </Label>
            {b.is_current && (
              <Label color={muted(t, 0.7)} style={{ flexShrink: 0 }}>
                current
              </Label>
            )}
            <CheckMark color={t.text} visible={(baseBranch ?? branches.current) === b.name} />
          </PickerItem>
        ))
      )}
      <PickerSeparator />
      <PickerItem id="__worktree" keepOpen onSelect={() => patchDraft({ worktree: !useWorktree })} style={{ paddingLeft: 10, paddingRight: 10 }}>
        <Icon source={G.worktree} size={14} color={t.text} />
        <Label color={t.text} truncate style={{ flexGrow: 1 }}>
          Create a worktree from this branch
        </Label>
        <CheckMark color={t.text} visible={useWorktree} />
      </PickerItem>
    </PickerMenu>
  )
}
