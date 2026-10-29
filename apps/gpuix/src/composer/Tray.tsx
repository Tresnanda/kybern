// The home screen's tray docked on the composer (`LandingTray` in
// `views/Composer.tsx`, chips in `views/trayChips.tsx`, wiring in
// `views/Draft.tsx`): an attached Up next task, Checkout / New worktree, and
// the branch to start from. The project is picked by the new chat's headline
// (ADE-62), so it has no chip here. Menus open upward, 8px from the chip.
import { useEffect, useState } from 'react'
import { Presence } from '../motion/Presence.tsx'
import { popTransform } from '../kit/Pop.tsx'
import { EASE } from '../motion/tokens.ts'
import { useControls } from '../kit/controls.ts'
import { IconButton } from '../kit/IconButton.tsx'
import { N } from '../nav/glyphs.ts'
import { PriorityGlyph } from '../tasks/Glyphs.tsx'
import { ink } from '../ui.tsx'
import { Icon } from '../icons.tsx'
import { GlassEdge } from '../kit/GlassEdge.tsx'
import { frostBackdrop, frostFill, useGlass } from '../platform/glass.ts'
import { Label, useTheme } from '../ui.tsx'
import { alpha } from '../transcript/kit.tsx'
import type { GitBranchesResult, MachineId, Project, ProjectId, TaskItem } from '../../../../packages/kybern-client/src/types.ts'
import type { ReactNode } from 'react'
import { useApp } from '../state.ts'
import { PickerChip } from '../kit/PickerChip.tsx'
import { SearchField } from '../kit/SearchField.tsx'
import { G } from './glyphs.ts'
import { CheckMark, muted, PickerItem, PickerLabel, PickerMenu, PickerSeparator } from './Menu.tsx'
import { loadBranches, patchDraft, useComposer } from './store.ts'
import { GroupBranchChip, ReposChip } from './GroupTray.tsx'
import { isGroupProject } from '../../../../packages/kybern-client/src/groups.ts'

export const COMPOSER_RADIUS = 19.2

/** `parentPath` in `views/Draft.tsx`: `…/projects` for the checkout hint. */
export function parentPath(p: string): string {
  const i = p.lastIndexOf('/')
  return i <= 0 ? p : '…/' + p.slice(p.slice(0, i).lastIndexOf('/') + 1, i)
}

/** Whether `LandingTray` draws anything: a free chat with no task attached has no chips, so the card sits alone. */
export const landingTrayShown = (projectId: ProjectId | null, task: TaskItem | null | undefined) => !!projectId || !!task

export function LandingTray({ projectId, useWorktree, task, onRemoveTask, still = false, remote }: {
  projectId: ProjectId | null
  /** The chat is made on another machine: its checkout of the project, whose branches the branch chip lists. */
  remote?: { machineId: MachineId; project: Project }
  useWorktree: boolean
  /** The Up next task attached to the message. */
  task?: TaskItem | null
  onRemoveTask?: () => void
  /** A frozen copy (the send transition's ghost): no entrance and no loading. */
  still?: boolean
}) {
  const t = useTheme()
  const everyProject = useApp((s) => s.projects)
  const project = projectId ? everyProject.find((p) => p.id === projectId) : undefined
  // A group's folder is often not a repository itself, but every member is: worktree mode works, and the branch chip
  // speaks for the members (`GroupTray.tsx`).
  const group = isGroupProject(project)
  const isGit = remote ? remote.project.is_git : project?.is_git ?? false
  // The branches are the ones of the machine the chat runs on (its checkout's id, read through its own client).
  const branchProjectId = remote ? remote.project.id : projectId
  const branchMachine = remote?.machineId
  useEffect(() => {
    if (!still && branchProjectId && isGit && !group) void loadBranches(branchProjectId, branchMachine)
  }, [branchProjectId, branchMachine, isGit, group, still])
  // The chip stays through its 120 ms fade after ×; it is not animated away by a send (the tray leaves as a whole).
  const [shownTask, setShownTask] = useState(task ?? null)
  if (task && task !== shownTask) setShownTask(task)
  if (!landingTrayShown(projectId, task ?? shownTask)) return null
  return (
    <TrayFrame>
      {shownTask && (
        <Presence show={!!task} enter={still ? undefined : popTransform()} exit={{ to: { opacity: 0 }, duration: 0.12, ease: EASE.out }} onGone={() => setShownTask(null)} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0, flexShrink: 1 }}>
          <AttachedTaskChip key={shownTask.id} task={shownTask} onRemove={onRemoveTask} />
          {project && <div style={{ width: 1, height: 16, flexShrink: 0, backgroundColor: ink(t, 0.06) }} />}
        </Presence>
      )}
      {project && <WorkspaceChip useWorktree={useWorktree} isGit={isGit || group} checkoutHint={parentPath(project.path)} />}
      {project && group && <GroupBranchChip project={project} useWorktree={useWorktree} still={still} />}
      {project && group && useWorktree && <ReposChip project={project} still={still} />}
      {project && isGit && !group && branchProjectId && <BranchChip projectId={branchProjectId} machineId={branchMachine} useWorktree={useWorktree} />}
    </TrayFrame>
  )
}

/** The attached task (spec §5): a selected chip with no chevron, its priority glyph and "KEY · Title", and a × that detaches it. */
function AttachedTaskChip({ task, onRemove }: { task: TaskItem; onRemove?: () => void }) {
  const c = useControls()
  return (
    <PickerChip
      testId="draft-attached-task"
      selected
      chevron={false}
      truncate
      maxWidth={252}
      label={`${task.key} ${task.title}, attached`}
      lead={<PriorityGlyph priority={task.priority} color={c.chip.selFg} />}
      style={{ paddingRight: 4 }}
    >
      <Label color={c.chip.selFg} size={13} lineHeight={18} weight={500} truncate style={{ maxWidth: 220 }}>{`${task.key} · ${task.title || 'Untitled task'}`}</Label>
      <IconButton testId="draft-attached-task-remove" size="sm" icon={N.x} glyph={12} color={c.chip.selFg} label={`Remove ${task.key} from message`} onClick={() => onRemove?.()} style={{ width: 20, height: 20 }} />
    </PickerChip>
  )
}

/** `LandingTray`'s strip: the card's backing colour, rounded on top, 93.33% wide, holding chips. The task dock's tray is the same strip.
 *  Whole-window glass makes it the composer's stacked frost (`StackedPanel`): the same tint over a scene blur, a hairline rim and a
 *  top highlight, open at the bottom where the card continues it; never an opaque slab beside the translucent card. */
export function TrayFrame({ children, testId = 'landing-tray' }: { children: ReactNode; testId?: string }) {
  const t = useTheme()
  const g = useGlass()
  // `--composer-backing-surface` (`kybern.css:12`, the light mix in `theme.logic`). With any glass on it takes the composer
  // card's own 90% (`--composer-surface`, `kit.css:2659`), so the strip is never an opaque slab above a translucent card.
  const solid = t.variant === 'dark' ? '#222222' : t.v('--composer-backing-surface')
  const backing = t.scope === 'none' ? solid : alpha(solid, 0.9)
  return (
    <div
      testId={testId}
      backdrop={frostBackdrop(g, 'composer', COMPOSER_RADIUS)}
      style={{
        position: 'relative',
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
        ...(g.on ? { borderWidth: 1, borderBottomWidth: 0, borderColor: g.frostRim, marginBottom: -1 } : {}),
        backgroundColor: frostFill(g, 'composer', backing, 'frostStacked'),
      }}
    >
      <GlassEdge radius={COMPOSER_RADIUS} color={g.frostHighlight} />
      {children}
    </div>
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
        <PickerChip bare icon={useWorktree ? G.worktree : G.laptop} open={open} truncate maxWidth={256}>{useWorktree ? 'New worktree' : 'Checkout'}</PickerChip>
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

function BranchChip({ projectId, machineId, useWorktree }: { projectId: ProjectId; machineId?: MachineId | undefined; useWorktree: boolean }) {
  const branches = useComposer((d) => (d.branches?.projectId === projectId && d.branches.machineId === machineId ? d.branches.result : null))
  const fetching = useComposer((d) => d.branches?.projectId === projectId && d.branches.machineId === machineId && !!d.branches.fetching)
  const baseBranch = useComposer((d) => d.draft.baseBranch)
  return (
    <BranchTrayChip
      branches={branches}
      fetching={fetching}
      baseBranch={baseBranch}
      useWorktree={useWorktree}
      onOpen={() => void loadBranches(projectId, machineId)}
      onBranch={(name) => patchDraft({ baseBranch: name })}
      onWorktree={(worktree) => patchDraft({ worktree })}
    />
  )
}

/** The branch list never grows past this; it scrolls inside the menu instead. */
const LIST_HEIGHT = 280

/** `BranchTrayChip`: the branch to start from, and a worktree toggle. `branches` is null while they load; `fetching`
 *  while the remotes are fetched behind the list. Remote-tracking branches come after the local ones. */
export function BranchTrayChip({
  branches,
  fetching = false,
  baseBranch,
  useWorktree,
  onOpen,
  onBranch,
  onWorktree,
}: {
  branches: GitBranchesResult | null
  fetching?: boolean
  baseBranch: string | null | undefined
  useWorktree: boolean
  onOpen: () => void
  /** The chosen branch, or null for the current one. */
  onBranch: (name: string | null) => void
  onWorktree: (useWorktree: boolean) => void
}) {
  const t = useTheme()
  const [query, setQuery] = useState('')
  const shown = baseBranch ?? branches?.current ?? 'Current branch'
  const search = query.trim().toLowerCase()
  const matches = branches?.branches.filter((b) => !search || b.name.toLowerCase().includes(search)) ?? []
  return (
    <PickerMenu
      testId="tray-branch"
      side="top"
      align="start"
      sideOffset={8}
      width={288}
      onOpenChange={(open) => {
        setQuery('')
        if (open) onOpen()
      }}
      trigger={(open) => <PickerChip testId="tray-branch-chip" bare icon={G.branch} open={open} truncate maxWidth={256}>{shown}</PickerChip>}
    >
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <PickerLabel>{useWorktree ? 'Fork the worktree from' : 'Branch'}</PickerLabel>
        <div style={{ flexGrow: 1 }} />
        {fetching && (
          <Label color={muted(t, 0.6)} size={12} style={{ flexShrink: 0, paddingRight: 8 }}>
            Fetching…
          </Label>
        )}
      </div>
      {branches !== null && branches.branches.length > 0 && (
        <div style={{ display: 'flex', paddingLeft: 4, paddingRight: 4, paddingBottom: 4 }}>
          <SearchField testId="tray-branch-search" label="Search branches" placeholder="Search branches" autoFocus width="100%" value={query} onChange={setQuery}
            onSubmit={() => { const first = matches[0]; if (first) onBranch(first.name === branches.current ? null : first.name) }} />
        </div>
      )}
      {branches === null ? (
        <PickerItem id="__loading" disabled onSelect={() => {}}>
          <Label color={t.textSecondary}>Loading branches…</Label>
        </PickerItem>
      ) : branches.branches.length === 0 ? (
        <PickerItem id="__empty" disabled onSelect={() => {}}>
          <Label color={t.textSecondary}>No branches yet. Make a first commit.</Label>
        </PickerItem>
      ) : matches.length === 0 ? (
        <PickerItem id="__nomatch" disabled onSelect={() => {}}>
          <Label color={t.textSecondary} truncate>{`No branches match “${query.trim()}”`}</Label>
        </PickerItem>
      ) : (
        // A repository can have hundreds of branches: the list scrolls inside the menu instead of growing past the window.
        <div style={{ display: 'flex', flexDirection: 'column', maxHeight: LIST_HEIGHT, overflowY: 'scroll' }}>
          {matches.map((b) => (
            <PickerItem key={b.name} id={`branch:${b.name}`} onSelect={() => onBranch(b.name === branches.current ? null : b.name)}>
              <Icon source={G.branch} size={14} color={t.text} />
              <Label color={t.text} truncate style={{ flexGrow: 1 }}>
                {b.name}
              </Label>
              {(b.is_current || b.remote) && (
                <Label color={muted(t, 0.7)} style={{ flexShrink: 0 }}>
                  {b.is_current ? 'current' : 'remote'}
                </Label>
              )}
              <CheckMark color={t.text} visible={(baseBranch ?? branches.current) === b.name} />
            </PickerItem>
          ))}
        </div>
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
      trigger={(open) => <PickerChip bare icon={G.folder} open={open} truncate maxWidth={256}>{current?.name ?? 'Choose a project'}</PickerChip>}
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
