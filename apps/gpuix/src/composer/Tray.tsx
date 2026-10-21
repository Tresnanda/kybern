// The home screen's tray docked on the composer (`LandingTray` in
// `views/Composer.tsx`, chips in `views/trayChips.tsx`, wiring in
// `views/Draft.tsx`): the project (or Free chat), Checkout / New worktree, and
// the branch to start from. Menus open upward, 8px from the chip.
import { useEffect } from 'react'
import { Icon } from '../icons.tsx'
import { Label, useTheme } from '../ui.tsx'
import type { GitBranchesResult, Project, ProjectId } from '../../../../packages/kybern-client/src/types.ts'
import type { ReactNode } from 'react'
import { useApp } from '../state.ts'
import { useSpaceProjects } from '../spaces/current.ts'
import { TrayChip } from './chips.tsx'
import { G } from './glyphs.ts'
import { CheckMark, muted, PickerItem, PickerLabel, PickerMenu, PickerSeparator } from './Menu.tsx'
import { loadBranches, patchDraft, useComposer } from './store.ts'

export const COMPOSER_RADIUS = 19.2

/** `parentPath` in `views/Draft.tsx`: `…/projects` for the checkout hint. */
export function parentPath(p: string): string {
  const i = p.lastIndexOf('/')
  return i <= 0 ? p : '…/' + p.slice(p.slice(0, i).lastIndexOf('/') + 1, i)
}

export function LandingTray({ projectId, useWorktree }: { projectId: ProjectId | null; useWorktree: boolean }) {
  const everyProject = useApp((s) => s.projects)
  const projects = useSpaceProjects()
  const project = projectId ? everyProject.find((p) => p.id === projectId) : undefined
  const list = [...projects].sort((a, b) => a.name.localeCompare(b.name))
  const isGit = project?.is_git ?? false
  useEffect(() => {
    if (projectId && isGit) void loadBranches(projectId)
  }, [projectId, isGit])
  return (
    <TrayFrame>
      {project ? (
        <ProjectChip projectId={project.id} projects={list} />
      ) : (
        <FreeChatChip projects={list} />
      )}
      {project && <WorkspaceChip useWorktree={useWorktree} isGit={isGit} checkoutHint={parentPath(project.path)} />}
      {project && isGit && <BranchChip projectId={project.id} useWorktree={useWorktree} />}
    </TrayFrame>
  )
}

/** `LandingTray`'s strip: the card's backing colour, rounded on top, 93.33% wide, holding chips. The task dock's tray is the same strip. */
export function TrayFrame({ children, testId = 'landing-tray' }: { children: ReactNode; testId?: string }) {
  const t = useTheme()
  // `--composer-backing-surface` (`kybern.css:12`, the light mix in `theme.logic`).
  const backing = t.variant === 'dark' ? '#222222' : t.v('--composer-backing-surface')
  return (
    <div
      testId={testId}
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
      {children}
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

function WorkspaceChip({ useWorktree, isGit, checkoutHint }: { useWorktree: boolean; isGit: boolean; checkoutHint: string }) {
  return <WorkspaceTrayChip useWorktree={useWorktree} isGit={isGit} checkoutHint={checkoutHint} onChange={(worktree) => patchDraft({ worktree })} />
}

/** `WorkspaceTrayChip`: Checkout or a new worktree. */
export function WorkspaceTrayChip({ useWorktree, isGit, checkoutHint, onChange }: { useWorktree: boolean; isGit: boolean; checkoutHint: string; onChange: (useWorktree: boolean) => void }) {
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
      <PickerItem id="local" onSelect={() => onChange(false)}>
        <Icon source={G.laptop} size={14} color={t.text} />
        <Label color={t.text} truncate style={{ flexGrow: 1 }}>
          Checkout
        </Label>
        <Label color={muted(t, 0.7)} style={{ flexShrink: 0 }}>
          {checkoutHint}
        </Label>
        <CheckMark color={t.text} visible={!useWorktree} />
      </PickerItem>
      <PickerItem id="worktree" disabled={!isGit} onSelect={() => onChange(true)}>
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

function BranchChip({ projectId, useWorktree }: { projectId: ProjectId; useWorktree: boolean }) {
  const branches = useComposer((d) => (d.branches?.projectId === projectId ? d.branches.result : null))
  const baseBranch = useComposer((d) => d.draft.baseBranch)
  return (
    <BranchTrayChip
      branches={branches}
      baseBranch={baseBranch}
      useWorktree={useWorktree}
      onOpen={() => void loadBranches(projectId)}
      onBranch={(name) => patchDraft({ baseBranch: name })}
      onWorktree={(worktree) => patchDraft({ worktree })}
    />
  )
}

/** `BranchTrayChip`: the branch to start from, and a worktree toggle. `branches` is null while they load. */
export function BranchTrayChip({
  branches,
  baseBranch,
  useWorktree,
  onOpen,
  onBranch,
  onWorktree,
}: {
  branches: GitBranchesResult | null
  baseBranch: string | null | undefined
  useWorktree: boolean
  onOpen: () => void
  /** The chosen branch, or null for the current one. */
  onBranch: (name: string | null) => void
  onWorktree: (useWorktree: boolean) => void
}) {
  const t = useTheme()
  const shown = baseBranch ?? branches?.current ?? 'Current branch'
  return (
    <PickerMenu
      testId="tray-branch"
      side="top"
      align="start"
      sideOffset={8}
      width={288}
      onOpenChange={(open) => open && onOpen()}
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
          <PickerItem key={b.name} id={`branch:${b.name}`} onSelect={() => onBranch(b.name === branches.current ? null : b.name)}>
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
      <PickerItem id="__worktree" keepOpen onSelect={() => onWorktree(!useWorktree)} style={{ paddingLeft: 10, paddingRight: 10 }}>
        <Icon source={G.worktree} size={14} color={t.text} />
        <Label color={t.text} truncate style={{ flexGrow: 1 }}>
          Create a worktree from this branch
        </Label>
        <CheckMark color={t.text} visible={useWorktree} />
      </PickerItem>
    </PickerMenu>
  )
}

/** `ProjectTrayChip` for a task that belongs to no project: choose the one the run starts in. */
export function ProjectPickChip({ projectId, projects, onPick }: { projectId: ProjectId | null; projects: Project[]; onPick: (id: ProjectId) => void }) {
  const t = useTheme()
  const current = projects.find((p) => p.id === projectId)
  return (
    <PickerMenu
      testId="tray-project"
      side="top"
      align="start"
      sideOffset={8}
      minWidth={224}
      trigger={(open) => <TrayChip icon={G.folder} label={current?.name ?? 'Choose a project'} pressed={open} strong={!current} />}
    >
      <PickerLabel>Run in</PickerLabel>
      {projects.map((p) => (
        <PickerItem key={p.id} id={p.id} onSelect={() => onPick(p.id)}>
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
