import { useSidebarRowLease } from './Window.tsx'
import { startProjectRename, stopProjectRename, useRenamingProject } from './renameProject.ts'
import { PROJECT_RENAME_COPY, renamedProject } from '../../../../packages/kybern-client/src/projectName.ts'
import { RpcCallError } from '../../../../packages/kybern-client/src/client.ts'
import { toast } from '../shell/toasts.tsx'
import { Button } from '../kit/Button.tsx'
import { CONTROL } from '../kit/controls.ts'
import { IconButton, type IconButtonProps } from '../kit/IconButton.tsx'
import { MoveToSpaceMenu } from '../spaces/MoveToSpace.tsx'
import { inCurrentSpace } from '../spaces/current.ts'
import { SPACE_COPY } from '../../../../packages/kybern-client/src/spaces.ts'
import { canOpenInSplit, collectThreadPanes, openThreadInSplit, useFocusedPane, useSplitRoot } from '../split/store.ts'
import { beginThreadDrag, trackThreadDrag, consumeThreadDrag, finishSplitDrag } from '../split/Workspace.tsx'
import { showDialog } from '../dialogs/store.ts'
import { activeEnvironment } from '../shell/environment.ts'
// Thread panel rows (`views/Sidebar.tsx`, `views/subagents/SubagentSidebarRow.tsx`,
// `lib/kit/sidebarRowStyles.ts`). Rows are 28px with an 8px radius, 14px text,
// `--sidebar-accent` on hover and `--sidebar-accent-active` when selected.
// Hovering a row swaps its resting glyph for its actions: they fade and slide in
// like `.t-reveal` (sidebar/motion.tsx), and the glyph fades back afterwards.
//
// Each row is memoized and owns its hover state, so moving the pointer re-renders
// one row and a list update re-renders only the rows whose props changed.
import { useGpuix, type PublicInstance } from '@gpuix/react'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { childState, canStopDelegation } from '../../../../packages/kybern-client/src/delegations.ts'
import { SUBAGENT_SIDEBAR_HOLD_MS, subagentThreadPhase, type SubagentPhase } from '../../../../packages/kybern-client/src/subagents.ts'
import { FREE_CHAT_PROJECT_ID, type Project, type Thread, type ThreadActivityState } from '../../../../packages/kybern-client/src/types.ts'
import { Icon } from '../icons.tsx'
import { MatrixLoader } from '../MatrixLoader.tsx'
import { addProject, archiveThread, errorText, removeProject, renameProject, updateThread } from '../nav/actions.ts'
import { N } from '../nav/glyphs.ts'
import { newThread, openThread } from '../nav/history.ts'
import { ContextMenu, Menu, MenuItem, MenuLabel, MenuSeparator, muted, Tip } from '../nav/overlay.tsx'
import { DEFAULT_FILTER, getNav, setNav, useNav } from '../nav/store.ts'
import { getClient, getState, toggleProject as toggleProjectState } from '../state.ts'
import { ink, Label, ProviderMark, useTheme } from '../ui.tsx'
import { raisedFill, useGlass } from '../platform/glass.ts'
import type { Theme } from '../theme.ts'
import { beginProjectDrag, consumeProjectDrag, endProjectPending, trackProjectDrag } from './reorder.tsx'
import { leftSource } from '../drag/leave.ts'
import { filterSummary, isFiltering, pendingBadge, providerLabel, threadAgents } from './model.ts'
import { popAnimation, popTransform, usePopOnChange } from '../kit/Pop.tsx'
import { Chevron } from '../motion/Chevron.tsx'
import { SwapOnChange } from '../motion/kit.tsx'
import { pressRow } from '../shell/motion.ts'
import { TICK_GAP, TreeLines, type TreeShape } from '../tree/Tree.tsx'
import { FadeBack, Leave, markDisclosure, MarqueeLabel, PadTween, Reveal, TitleSwap } from './motion.tsx'

/** `DisclosureChevron`: a chevron that turns down with its content (220 ms, `motion/Chevron.tsx`). Rows re-export it for their callers. */
export { Chevron }

/** Open or close a project (or Recents); the rows it adds or removes animate as a block. */
function toggleProject(id: string) {
  markDisclosure()
  toggleProjectState(id)
}

/** Whether a row has been hovered since it mounted: its glyph fades back only after a hover. */
function useWasRevealed(reveal: boolean) {
  const [was, setWas] = useState(false)
  if (reveal && !was) setWas(true)
  return was
}

/** The group's 6px inset, on each row: the virtual list ignores padding. */
export const INSET = { paddingLeft: 6, paddingRight: 6 } as const
/** `pr-[4.75rem]`: room for the revealed actions. */
const ACTIONS_PAD = 76
/** The project row's trailing room for the New thread button, 4px clear of the title. */
const PROJECT_PAD = 24
/**
 * Where a row's trailing `sm` buttons sit: centred on the row's height (never a fixed `top`, which drifts when the
 * kit's control height changes), with the 15px glyph 8.5px from the edge, the row's own padding. The project row's
 * activity glyph then ends 6px before the New thread glyph (`PROJECT_PAD - 2` from the row padding).
 */
const TRAILING = { position: 'absolute', top: 0, bottom: 0, right: 4, display: 'flex', alignItems: 'center' } as const

export const accent = (t: Theme) => t.v('--sidebar-accent')
export const accentActive = (t: Theme) => t.v('--sidebar-accent-active')
/** `text-foreground/95`: every resting sidebar label and its icon. */
export const resting = (t: Theme) => ink(t, 0.95)

/** amber-500 / dark:amber-300/90 (`StatusGlyph` pending dot). */
const amberDot = (t: Theme) => (t.variant === 'dark' ? 'rgba(255, 210, 48, 0.9)' : '#fe9a00')
/** amber-600 / dark:amber-300/90 (the "Pending" word). */
const amberText = (t: Theme) => (t.variant === 'dark' ? 'rgba(255, 210, 48, 0.9)' : '#e17100')

/** One native ancestor owns the entire row, including its revealed controls.
 * Child enter/leave counters become unbalanced when controls unmount on reflow.
 */
function useHover() {
  const [hover, setHover] = useState(false)
  return { hover, bind: {
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
  } }
}

/** Right-click opens a context menu at the pointer. */
function useContextMenu() {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  useSidebarRowLease(at !== null)
  return {
    at,
    close: () => setAt(null),
    onAuxClick: (e: { isRightClick?: boolean; button?: number; x?: number; y?: number }) => {
      if (e.isRightClick || e.button === 2) setAt({ x: e.x ?? 0, y: e.y ?? 0 })
    },
  }
}

/** The kit `IconButton` with the sidebar's tooltip (`tooltip` is the text, then any shortcut keys). */
export function SidebarIconButton({ tooltip, tooltipSide = 'top', ...props }: IconButtonProps & { tooltip?: string | string[]; tooltipSide?: 'top' | 'bottom' }) {
  const button = <IconButton {...props} />
  if (!tooltip) return button
  const [text, ...keys] = Array.isArray(tooltip) ? tooltip : [tooltip]
  return (
    <Tip label={text!} shortcut={keys.length ? keys : undefined} side={tooltipSide} size={CONTROL[props.size ?? 'md'].height}>
      {button}
    </Tip>
  )
}

/**
 * The old numeric-size sidebar button, kept as a thin wrapper over `SidebarIconButton` for `dock/Dock.tsx`'s tab strip (the tab-strip
 * lane replaces it). New code uses `kit/IconButton` or `SidebarIconButton`.
 */
function LegacyIconButton({ size = 20, glyph = 14, tooltip, tooltipSide, ...rest }: { icon: string; size?: number; glyph?: number; label: string; tooltip?: string | string[]; tooltipSide?: 'top' | 'bottom'; onClick?: () => void; active?: boolean; testId?: string; press?: boolean; radius?: number; color?: string; hoverColor?: string }) {
  return <SidebarIconButton icon={rest.icon} label={rest.label} onClick={rest.onClick} active={rest.active} testId={rest.testId} size={size >= 32 ? 'lg' : size >= 26 ? 'md' : 'sm'} glyph={glyph} tooltip={tooltip} tooltipSide={tooltipSide} />
}
export { LegacyIconButton as IconButton }

export function Dot({ color, pop = false }: { color: string; /** Pops in (`t-pop`) when it mounts. */ pop?: boolean }) {
  return <div paintTransform={pop ? popTransform() : undefined} style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color, flexShrink: 0 }} />
}

type GlyphState = 'pending' | 'working' | 'failed' | 'monitoring' | 'unread' | 'pinned' | 'none'

/**
 * `StatusGlyph`: pending, working, failed, monitoring, unread, in that order (then the pin of a pinned thread). A change cross-swaps
 * the way `IconSwap` does (the old glyph shrinks and blurs out while the new one grows in, 250 ms), and a failed or unread dot that
 * appears after the row first rendered also pops, like "Pending". The box keeps its size, so the swap never moves the row.
 */
export function StatusGlyph({ status, activity, unread, pinned = false }: { status: Thread['status'] | null; activity?: ThreadActivityState; unread?: boolean; pinned?: boolean }) {
  const t = useTheme()
  const state: GlyphState = status === 'awaiting-approval' ? 'pending' : status === 'running' || activity === 'working' ? 'working' : status === 'failed' ? 'failed' : activity === 'monitoring' ? 'monitoring' : unread ? 'unread' : pinned ? 'pinned' : 'none'
  const pop = usePopOnChange(state === 'failed' || state === 'unread')
  const glyph =
    state === 'pending' ? <Dot color={amberDot(t)} />
    : state === 'working' ? <MatrixLoader cycle={1600} />
    : state === 'failed' ? <Dot color={t.red} pop={pop} />
    : state === 'monitoring' ? <Icon source={N.clock} size={12} color={muted(t, 0.75)} />
    : state === 'unread' ? <Dot color={t.link} pop={pop} />
    : state === 'pinned' ? <Icon source={N.pinFilled} size={12} color={muted(t, 0.34)} />
    : null
  return (
    <SwapOnChange kind="icon" active={state} style={{ width: 15, height: 15 }}>
      {glyph}
    </SwapOnChange>
  )
}

/** `DraftMarker`: the 12px pencil for an unsent composer draft. */
function DraftMarker() {
  const t = useTheme()
  return (
    <div style={{ display: 'flex', width: 16, height: 16, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
      <Icon source={N.pencil} size={12} color={muted(t, 0.65)} />
    </div>
  )
}

/**
 * Tree connectors for a nested row (`../tree`), in the row box's coordinates (the `INSET` padding included). A parent at
 * level L hangs its children from a stem under its provider mark (x = 44 + 20·L); each child's tick stops 3px short
 * of its own mark, the last child ends the stem in the elbow, and a child with children of its own wears its chevron
 * on the junction. `anchor` is the mark's centre line.
 */
function rowTree({ depth, last, rails, open, toggle, anchor }: { depth: number; last: boolean; rails: number; open: boolean; toggle: boolean; anchor: number }): TreeShape {
  const stem = (level: number) => INSET.paddingLeft + 38 + level * 20
  const outer: number[] = []
  for (let level = 0; level < depth - 1; level++) if (rails & (1 << level)) outer.push(stem(level))
  return {
    anchor,
    rails: outer,
    ...(depth > 0 ? { branch: { x: stem(depth - 1), joint: toggle ? 'toggle' : 'node', last, tickEnd: INSET.paddingLeft + 32 + depth * 20 - TICK_GAP } } : {}),
    // Under the 12px mark, a hairline gap below its glyph.
    ...(open ? { below: { x: stem(depth), from: anchor + 6 + TICK_GAP } } : {}),
  }
}

function useRowTree(input: Parameters<typeof rowTree>[0]) {
  const { depth, last, rails, open, toggle, anchor } = input
  return useMemo(() => rowTree({ depth, last, rails, open, toggle, anchor }), [depth, last, rails, open, toggle, anchor])
}

/** The expand control for a row's nested children (`size-6`). */
function ChildToggle({ depth, open, onToggle, label, testId }: { depth: number; open: boolean; onToggle: () => void; label: string; testId?: string }) {
  const t = useTheme()
  const { hover, bind } = useHover()
  return (
    <div
      testId={testId}
      aria-label={label}
      role="button"
      {...bind}
      onClick={onToggle}
      // A root row's chevron leads its mark; a nested row's sits on its parent's stem, under the parent's mark.
      style={{ position: 'absolute', left: depth === 0 ? 5 : 6 + depth * 20, top: 2, width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, cursor: 'pointer' }}
    >
      <Chevron open={open} color={hover ? t.text : muted(t, 1)} />
    </div>
  )
}

/** Add project: pick a folder with the system panel, then open its draft (`onAddProject`). */
export function useAddProject() {
  const { renderer } = useGpuix()
  return async () => {
    if (getState().status !== 'open') return
    if (!activeEnvironment().local) return showDialog({ kind: 'project' })
    const paths = await renderer?.promptForPaths?.({ directories: true, files: false, prompt: 'Add project' })
    if (paths?.[0]) await addProject(paths[0]).catch((e) => console.error('[sidebar] Unable to add project:', errorText(e)))
  }
}

// ---- section label ("Projects", with filter and add) ----

export const SectionLabel = memo(function SectionLabel({ text = 'Projects' }: { text?: string }) {
  const t = useTheme()
  const filter = useNav((s) => s.filter)
  const threads = useNav(() => getState().threads)
  const [menuOpen, setMenuOpen] = useState(false)
  useSidebarRowLease(menuOpen)
  const onAddProject = useAddProject()
  const filtering = isFiltering(filter)
  const summaryPop = usePopOnChange(filtering)
  const agents = threadAgents(threads, filter)
  return (
    <div style={{ paddingTop: 10, paddingBottom: 4, ...INSET }}>
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center', height: 28, paddingLeft: 8, paddingRight: 76, gap: 6 }}>
        <Label color={muted(t, 0.58)} truncate>{text}</Label>
        {filtering && (
          <>
            <Label color={muted(t, 0.58)}>·</Label>
            <Label color={ink(t, 0.7)} truncate paintAnimation={summaryPop ? popAnimation() : undefined}>
              {filterSummary(filter)}
            </Label>
          </>
        )}
        {/* Creation affordances stay on screen (muted, brighter under the pointer): Filter and Add project are not hover reveals. */}
        <div style={TRAILING}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Menu
              open={menuOpen}
              onOpenChange={setMenuOpen}
              align="end"
              minWidth={192}
              testId="sidebar-filter"
              trigger={() => <SidebarIconButton icon={N.filter} size="sm" glyph={15} label="Filter threads" tooltip={menuOpen ? undefined : 'Filter threads'} active={filtering} />}
            >
              <MenuLabel>Show</MenuLabel>
              {(['all', 'pinned', 'working'] as const).map((value) => (
                <MenuItem
                  key={value}
                  id={`show-${value}`}
                  label={value === 'all' ? 'All threads' : value === 'pinned' ? 'Pinned' : 'Working'}
                  checked={filter.threads === value}
                  onSelect={() => setNav({ filter: { ...getNav().filter, threads: value } })}
                />
              ))}
              {agents.length > 1 && (
                <>
                  <MenuSeparator />
                  <MenuLabel>Agent</MenuLabel>
                  <MenuItem id="agent-all" label="All agents" checked={!filter.agent} onSelect={() => setNav({ filter: { ...getNav().filter, agent: null } })} />
                  {agents.map((kind) => (
                    <MenuItem key={kind} id={`agent-${kind}`} label={providerLabel(kind)} checked={filter.agent === kind} onSelect={() => setNav({ filter: { ...getNav().filter, agent: kind } })} />
                  ))}
                </>
              )}
              {filtering && (
                <>
                  <MenuSeparator />
                  <MenuItem id="clear" label="Clear filters" onSelect={() => setNav({ filter: DEFAULT_FILTER })} />
                </>
              )}
            </Menu>
            <SidebarIconButton icon={N.plus} size="sm" glyph={15} label="Add project" tooltip="Add project" onClick={() => void onAddProject()} testId="add-project" />
            </div>
        </div>
      </div>
    </div>
  )
})

/** Empty states under "Projects". */
export const MessageRow = memo(function MessageRow({ text, clearFilter }: { text: string; clearFilter?: boolean }) {
  const t = useTheme()
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 6, paddingLeft: 14, paddingRight: 14, paddingTop: 8, paddingBottom: 8, minWidth: 0 }}>
      {/* `flexShrink` + `minWidth: 0` let the sentence wrap inside the column instead of running out of it. */}
      <Label color={muted(t, clearFilter ? 0.6 : 0.48)} lineHeight={21} style={{ minWidth: 0, flexShrink: 1 }}>{text}</Label>
      {clearFilter && (
        <Button variant="ghost" size="sm" onClick={() => setNav({ filter: DEFAULT_FILTER })}>Show all threads</Button>
      )}
    </div>
  )
})

// ---- project header ----

export const ProjectHeader = memo(function ProjectHeader({
  project,
  first,
  open,
  active,
  status,
  activity,
  hasDraft,
  canMoveUp,
  canMoveDown,
}: {
  project: Project
  first: boolean
  open: boolean
  active: boolean
  status: 'awaiting-approval' | 'running' | 'idle' | null
  activity: ThreadActivityState | undefined
  hasDraft: boolean
  canMoveUp: boolean
  canMoveDown: boolean
}) {
  const t = useTheme()
  const { hover, bind } = useHover()
  const menu = useContextMenu()
  const { renderer } = useGpuix()
  const headerRef = useRef<PublicInstance | null>(null)
  const wasHovered = useWasRevealed(hover)
  const g = useGlass()
  const renaming = useRenamingProject(project.id)
  useSidebarRowLease(renaming)
  const [name, setName] = useState(project.name)
  // Esc (and Enter) end the edit before the blur they cause: only the first one counts.
  const finished = useRef(false)
  useEffect(() => { if (renaming) { finished.current = false; setName(project.name) } }, [renaming])
  const finishRename = (save: boolean) => {
    if (finished.current) return
    finished.current = true
    stopProjectRename(project.id)
    const next = save ? renamedProject(name, project.name) : null
    if (next) {
      renameProject(project.id, next).catch((e) => toast.error(e instanceof RpcCallError ? e.message : PROJECT_RENAME_COPY.failure))
    }
  }
  const move = (offset: -1 | 1) => {
    const visible = getState()
      .projects.filter((p) => inCurrentSpace(p.id))
      .map((p) => p.id)
      .filter((id) => id !== FREE_CHAT_PROJECT_ID)
    const order = [...getNav().projectOrder.filter((id) => visible.includes(id)), ...visible.filter((id) => !getNav().projectOrder.includes(id)).sort((a, b) => nameOf(a).localeCompare(nameOf(b)))]
    const from = order.indexOf(project.id)
    const to = from + offset
    if (from < 0 || to < 0 || to >= order.length) return
    order.splice(from, 1)
    order.splice(to, 0, project.id)
    setNav({ projectOrder: order })
  }
  return (
    <div style={{ paddingTop: first ? 0 : 12, ...INSET }}>
      <div {...bind} style={{ position: 'relative' }}>
        <div
          testId={`project-${project.id}`}
          ref={headerRef}
          onMouseDown={(e) => { if (!renaming) beginProjectDrag(project.id, e, renderer, (headerRef.current && renderer?.getElementBounds?.(headerRef.current.id)) || null) }}
          onMouseMove={trackProjectDrag}
          onMouseUp={endProjectPending}
          onMouseLeave={(e) => { if (!leftSource(e, renderer)) return; trackProjectDrag(e, true); endProjectPending() }}
          onAuxClick={menu.onAuxClick}
          onClick={() => {
            if (renaming || consumeProjectDrag(project.id)) return
            if (active) toggleProject(project.id)
            else newThread(project.id)
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            height: 28,
            paddingLeft: 8,
            paddingRight: 8,
            borderRadius: 8,
            cursor: 'pointer',
            ...(active ? { backgroundColor: accentActive(t) } : hover ? { backgroundColor: accent(t) } : {}),
            ...pressRow(t, active ? accentActive(t) : accent(t)),
          }}
        >
          <div style={{ display: 'flex', width: 16, height: 16, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            {/* The folder fades back in as the disclosure control leaves. */}
            {!hover && (
              <FadeBack play={wasHovered}>
                <Icon source={open ? N.folderOpen : N.folder} size={16} color={resting(t)} />
              </FadeBack>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexGrow: 1, minWidth: 0 }}>
            {renaming ? (
              <input
                autoFocus
                value={name}
                aria-label={PROJECT_RENAME_COPY.field}
                onChange={(e) => setName(e.value ?? '')}
                onSubmit={() => finishRename(true)}
                onBlur={() => finishRename(true)}
                onKeyDown={(e) => { if (e.key === 'escape') finishRename(false) }}
                testId={`rename-project-${project.id}`}
                style={{ flexGrow: 1, minWidth: 0, height: 20, paddingLeft: 4, paddingRight: 4, borderRadius: 4, borderWidth: 1, borderColor: t.v('--ring'), backgroundColor: raisedFill(g, t.surface), color: t.text, fontSize: 14 }}
              />
            ) : (
              <Label color={active ? t.text : resting(t)} truncate>
                {project.name}
              </Label>
            )}
            {hasDraft && !renaming && <DraftMarker />}
            {/* Room for the always-visible New thread button. */}
            <PadTween width={PROJECT_PAD} cancelGap={8} />
          </div>
          {!open && status && !hover && (
            <div style={{ display: 'flex', minWidth: 26, justifyContent: 'flex-end', alignItems: 'center', flexShrink: 0, marginRight: PROJECT_PAD - 2 }}>
              <StatusGlyph status={status} activity={activity} />
            </div>
          )}
        </div>
        {/* The folder gives way to the disclosure control on hover; both leave with a fade when the pointer does. */}
        <div
          testId={`project-toggle-${project.id}`}
          role="button"
          aria-label={open ? 'Collapse' : 'Expand'}
          onClick={() => toggleProject(project.id)}
          style={{ position: 'absolute', left: 8, top: 6, width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, cursor: 'pointer', ...(hover ? {} : { pointerEvents: 'none' }) }}
        >
          <Reveal show={hover} slide={false}>
            <Chevron open={open} color={ink(t, 0.8)} />
          </Reveal>
        </div>
        <div style={{ ...TRAILING, gap: 6 }}>
          {/* A creation affordance: always on screen, muted until the pointer is on it. */}
          <SidebarIconButton icon={N.newThread} size="sm" glyph={15} label="New thread" tooltip="New thread" onClick={() => newThread(project.id)} testId={`project-new-${project.id}`} />
        </div>
      </div>
      {menu.at && (
        <ContextMenu at={menu.at} onClose={menu.close} testId="project-menu">
          <MenuItem id="new" icon={N.newThread} label="New thread" onSelect={() => newThread(project.id)} />
          <MenuItem id="resume" icon={N.clock} label="Resume session" onSelect={() => setNav({ sessions: { projectId: project.id } })} />
          <MenuItem id="rename" testId="project-menu-rename" icon={N.pencil} label={PROJECT_RENAME_COPY.menu} onSelect={() => startProjectRename(project.id)} />
          {(canMoveUp || canMoveDown) && (
            <>
              <MenuSeparator />
              <MenuItem id="up" icon={N.arrowUp} label="Move up" disabled={!canMoveUp} onSelect={() => move(-1)} />
              <MenuItem id="down" icon={N.arrowDown} label="Move down" disabled={!canMoveDown} onSelect={() => move(1)} />
            </>
          )}
          <MoveToSpaceMenu project={project} />
          <MenuSeparator />
          <MenuItem
            id="remove"
            icon={N.archive}
            label="Remove project"
            destructive
            onSelect={() => void removeProject(project.id).catch((e) => console.error('[sidebar] Unable to remove project:', errorText(e)))}
          />
        </ContextMenu>
      )}
    </div>
  )
})

const nameOf = (id: string) => getState().projects.find((p) => p.id === id)?.name ?? id

// ---- thread rows ----

export const ThreadRow = memo(function ThreadRow({
  thread,
  depth,
  childCount,
  childrenOpen,
  nested,
  last = false,
  rails = 0,
  selected,
  activity,
  unread,
  hasDraft,
  onToggleChildren,
}: {
  thread: Thread
  depth: number
  childCount: number
  childrenOpen: boolean
  nested: boolean
  last?: boolean
  rails?: number
  selected: boolean
  activity: ThreadActivityState | undefined
  unread: boolean
  hasDraft: boolean
  onToggleChildren: (id: string, open: boolean) => void
}) {
  const t = useTheme()
  const g = useGlass()
  const { hover, bind } = useHover()
  const menu = useContextMenu()
  const [renaming, setRenaming] = useState(false)
  useSidebarRowLease(renaming)
  const [title, setTitle] = useState(thread.title)
  const splitRoot = useSplitRoot(), focusedPane = useFocusedPane()
  const inSplit = collectThreadPanes(splitRoot).some((pane) => pane.threadId === thread.id)
  const { renderer } = useGpuix()
  const rowRef = useRef<PublicInstance | null>(null)
  const badge = pendingBadge(thread.status, useNav((s) => s.pending[thread.id]))
  const hasGlyph = thread.status !== 'idle' || !!activity || unread || !!badge
  const reveal = hover && !renaming
  const pendingPop = usePopOnChange(!!badge)
  const wasRevealed = useWasRevealed(reveal)
  const tree = useRowTree({ depth, last, rails, open: nested && childrenOpen && childCount > 0, toggle: childCount > 0, anchor: 16 })
  const commitRename = () => {
    setRenaming(false)
    const next = title.trim()
    if (next && next !== thread.title) void updateThread(thread.id, { title: next }).catch((e) => console.error('[sidebar] Unable to rename:', errorText(e)))
    else setTitle(thread.title)
  }
  return (
    <div style={{ position: 'relative', paddingTop: 2, ...INSET }}>
      <div {...bind} style={{ position: 'relative' }}>
        <div
          testId={`thread-${thread.id}`}
          ref={rowRef}
          onMouseDown={e => beginThreadDrag(thread.id, e, () => renderer?.clearSelection?.(), { title: thread.title || 'Untitled', kind: thread.provider.kind, bounds: () => (rowRef.current ? renderer?.getElementBounds?.(rowRef.current.id) : null) ?? null })}
          onMouseMove={trackThreadDrag}
          onMouseUp={finishSplitDrag}
          onAuxClick={menu.onAuxClick}
          onClick={() => {
            if (!consumeThreadDrag(thread.id) && !renaming) openThread(thread.id)
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            height: 28,
            paddingLeft: nested ? 32 + depth * 20 : 8,
            borderRadius: 8,
            overflow: 'hidden',
            cursor: 'pointer',
            userSelect: 'none',
            ...(selected ? { backgroundColor: accentActive(t) } : reveal ? { backgroundColor: accent(t) } : {}),
            ...pressRow(t, selected ? accentActive(t) : accent(t)),
          }}
        >
          <div style={{ display: 'flex', width: 12, height: 12, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <ProviderMark kind={thread.provider.kind} size={12} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexGrow: 1, minWidth: 0 }}>
            {renaming ? (
              <input
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.value ?? '')}
                onSubmit={commitRename}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'escape') {
                    setTitle(thread.title)
                    setRenaming(false)
                  }
                }}
                testId={`rename-${thread.id}`}
                style={{ flexGrow: 1, minWidth: 0, height: 20, paddingLeft: 4, paddingRight: 4, borderRadius: 4, borderWidth: 1, borderColor: t.v('--ring'), backgroundColor: raisedFill(g, t.surface), color: t.text, fontSize: 14 }}
              />
            ) : (
              <TitleSwap text={thread.coordinator_project_id ? 'Open coordinator' : thread.title || 'Untitled'}>
                <MarqueeLabel hover={hover} text={thread.coordinator_project_id ? 'Open coordinator' : thread.title || 'Untitled'} color={selected ? t.text : resting(t)} />
              </TitleSwap>
            )}
            {hasDraft && !renaming && <DraftMarker />}
            {badge && (
              <Label color={amberText(t)} size={10} weight={500} style={{ flexShrink: 0 }} paintAnimation={pendingPop ? popAnimation() : undefined}>
                {badge}
              </Label>
            )}
          </div>
          {thread.worktree && <Icon source={N.worktree} size={12} color={muted(t, 0.55)} />}
          {/* The trailing padding, less the row's 8px gap. */}
          <PadTween width={(reveal ? ACTIONS_PAD : hasGlyph || thread.pinned ? 28 : 8) - 8} />
        </div>
        {childCount > 0 && (
          <ChildToggle
            depth={depth}
            open={childrenOpen}
            onToggle={() => onToggleChildren(thread.id, !childrenOpen)}

            testId={`children-${thread.id}`}
            label={`${childrenOpen ? 'Collapse' : 'Expand'} ${childCount} nested ${childCount === 1 ? 'thread' : 'threads'} of ${thread.title || 'Untitled'}`}
          />
        )}
        {/* The resting glyph and the hover actions share the row's right edge: the glyph fades back in as the actions fade out. The glyph box stays
            mounted so a status change cross-swaps (`StatusGlyph`); it is passive, so the actions above it keep the pointer. */}
        {!reveal && (
          <div style={{ position: 'absolute', top: 0, bottom: 0, right: 6, display: 'flex', alignItems: 'center', pointerEvents: 'none' }}>
            <FadeBack play={wasRevealed} style={{ width: 15 }}>
              <StatusGlyph status={badge ? 'awaiting-approval' : thread.status} activity={activity} unread={unread} pinned={thread.pinned} />
            </FadeBack>
          </div>
        )}
        <div style={{ position: 'absolute', top: 0, bottom: 0, right: 6, display: 'flex', alignItems: 'center' }}>
          <Reveal show={reveal}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <SidebarIconButton
                icon={thread.pinned ? N.pinFilled : N.pin}
                size="sm"
                glyph={15}
                label={thread.pinned ? 'Unpin' : 'Pin'}

                testId={`pin-${thread.id}`}
                onClick={() => void updateThread(thread.id, { pinned: !thread.pinned }).catch((e) => console.error('[sidebar] Unable to pin:', errorText(e)))}
              />
              <SidebarIconButton
                icon={N.archive}
                size="sm"
                glyph={15}
                label="Archive"

                testId={`archive-${thread.id}`}
                onClick={() => void archiveThread(thread.id).catch((e) => console.error('[sidebar] Unable to archive:', errorText(e)))}
              />
            </div>
          </Reveal>
        </div>
      </div>
      {nested && <TreeLines shape={tree} />}
      {menu.at && (
        <ContextMenu at={menu.at} onClose={menu.close} testId="thread-menu">
          <MenuItem
            id="rename"
            icon={N.pencil}
            label="Rename thread"
            onSelect={() => {
              setTitle(thread.title)
              setRenaming(true)
            }}
          />
          <MenuItem
            id="pin"
            icon={thread.pinned ? N.pinFilled : N.pin}
            label={thread.pinned ? 'Unpin' : 'Pin'}
            onSelect={() => void updateThread(thread.id, { pinned: !thread.pinned })}
          />
          <MenuItem id="handoff" icon={N.handoff} label="Hand off to another agent" onSelect={() => setNav({ handoff: { threadId: thread.id, target: null } })} />
          <MenuSeparator />
          <MenuItem id="right" icon={N.splitRight} label="Open to the right" disabled={!canOpenInSplit(thread.id, 'horizontal')} onSelect={() => { openThreadInSplit(thread.id, 'horizontal') }} />
          <MenuItem id="below" icon={N.splitDown} label="Open below" disabled={!canOpenInSplit(thread.id, 'vertical')} onSelect={() => { openThreadInSplit(thread.id, 'vertical') }} />
          <MenuSeparator />
          {thread.worktree && <MenuItem id="cleanup" icon={N.worktree} label="Remove worktree…" onSelect={() => showDialog({ kind: 'worktree', threadId: thread.id })} />}
          {thread.worktree && <MenuItem id="branch" icon={N.branch} label={thread.worktree.branch} disabled onSelect={() => {}} />}
          <MenuItem id="archive" icon={N.archive} label="Archive" destructive onSelect={() => void archiveThread(thread.id)} />
        </ContextMenu>
      )}
    </div>
  )
})

/** Working, done, failed or stopped, for either kind of child (`rowPhase`). */
export function rowPhase(thread: Thread): SubagentPhase {
  if (thread.subagent) return subagentThreadPhase(thread)
  const { phase } = childState(thread)
  return phase === 'working' || phase === 'waiting' ? 'working' : phase === 'done' ? 'done' : phase === 'failed' ? 'failed' : 'stopped'
}

/** Indentation stops growing here; deeper rows keep the cap. */
const MAX_DEPTH = 3

/**
 * A subagent or delegated child nested under its parent. It shows while it
 * works and while it is open; when it finishes it holds its check for 600ms,
 * then leaves.
 */
export const ChildRow = memo(function ChildRow({
  thread,
  depth,
  childCount,
  childrenOpen,
  last = false,
  rails = 0,
  selected,
  onToggleChildren,
}: {
  thread: Thread
  depth: number
  childCount: number
  childrenOpen: boolean
  last?: boolean
  rails?: number
  selected: boolean
  onToggleChildren: (id: string, open: boolean) => void
}) {
  const t = useTheme()
  const { hover, bind } = useHover()
  const menu = useContextMenu()
  const { renderer } = useGpuix()
  const rowRef = useRef<PublicInstance | null>(null)
  const info = (thread.subagent ?? thread.delegation)!
  const delegated = !thread.subagent
  const phase = rowPhase(thread)
  const working = phase === 'working'
  const level = Math.min(depth, MAX_DEPTH)
  const completedAt = info.completed_at ? Date.parse(info.completed_at) : NaN
  // The hold elapsed (or Dismiss was pressed): the row collapses, then is dismissed.
  // Viewing the row, or it working again, stops the leave.
  const [leaveAsked, setLeaveAsked] = useState(false)
  const leaving = leaveAsked && !working && !selected
  useSidebarRowLease(leaving || (!working && !selected))
  if (leaveAsked && working) setLeaveAsked(false)

  // A finished row that is not open holds its check, then leaves.
  useEffect(() => {
    if (working || selected || leaveAsked) return
    const age = Number.isFinite(completedAt) ? Date.now() - completedAt : SUBAGENT_SIDEBAR_HOLD_MS
    const hold = Math.min(SUBAGENT_SIDEBAR_HOLD_MS, Math.max(0, SUBAGENT_SIDEBAR_HOLD_MS - age))
    const timer = setTimeout(() => setLeaveAsked(true), hold)
    return () => clearTimeout(timer)
  }, [working, selected, leaveAsked, completedAt, thread.id])

  const reveal = hover && !working && !leaving
  const badge = pendingBadge(thread.status, useNav((s) => s.pending[thread.id]))
  const pendingPop = usePopOnChange(!!badge)
  const wasRevealed = useWasRevealed(reveal)
  const tree = useRowTree({ depth: level, last, rails, open: childrenOpen && childCount > 0, toggle: childCount > 0, anchor: 17 })
  const body = (
    <div style={{ position: 'relative', paddingTop: 3, paddingBottom: 1, ...INSET }}>
      <div {...bind} style={{ position: 'relative' }}>
        <div
          testId={`child-${thread.id}`}
          ref={rowRef}
          onMouseDown={e => beginThreadDrag(thread.id, e, () => renderer?.clearSelection?.(), { title: thread.title || 'Untitled', kind: thread.provider.kind, bounds: () => (rowRef.current ? renderer?.getElementBounds?.(rowRef.current.id) : null) ?? null })}
          onMouseMove={trackThreadDrag}
          onMouseUp={finishSplitDrag}
          onAuxClick={menu.onAuxClick}
          onClick={() => { if (!consumeThreadDrag(thread.id)) openThread(thread.id) }}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            height: 28,
            paddingLeft: 32 + level * 20,
            paddingRight: 28,
            borderRadius: 8,
            overflow: 'hidden',
            cursor: 'pointer',
            ...(selected ? { backgroundColor: accentActive(t) } : hover ? { backgroundColor: accent(t) } : {}),
            ...pressRow(t, selected ? accentActive(t) : accent(t)),
          }}
        >
          <div style={{ display: 'flex', width: 12, height: 12, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <ProviderMark kind={thread.provider.kind} size={12} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexGrow: 1, minWidth: 0 }}>
            {/* A little quieter than its parent, so the parent stays dominant. */}
            <MarqueeLabel hover={hover} text={thread.title || (delegated ? 'Agent' : 'Subagent')} color={selected ? t.text : ink(t, 0.82)} />
            {badge && (
              <Label color={amberText(t)} size={10} weight={500} style={{ flexShrink: 0 }} paintAnimation={pendingPop ? popAnimation() : undefined}>
                {badge}
              </Label>
            )}
          </div>
        </div>
        {childCount > 0 && (
          <ChildToggle
            depth={level}
            open={childrenOpen}
            onToggle={() => onToggleChildren(thread.id, !childrenOpen)}

            testId={`children-${thread.id}`}
            label={`${childrenOpen ? 'Collapse' : 'Expand'} ${childCount} nested ${delegated ? 'agent' : 'subagent'}${childCount === 1 ? '' : 's'}`}
          />
        )}
        {/* No glyph while it works: its presence says so, and the parent shows the loader. */}
        {!reveal && !working && (
          <div style={{ position: 'absolute', top: 0, bottom: 0, right: 6, display: 'flex', alignItems: 'center', pointerEvents: 'none' }}>
            <FadeBack play={wasRevealed} style={{ width: 15 }} testId={`child-result-${thread.id}`}>
              {phase === 'failed' ? (
                <Dot color={t.red} />
              ) : phase === 'stopped' ? (
                <Icon source={N.stop} size={8} color={muted(t, 0.45)} />
              ) : (
                <Icon source={N.check} size={12} color={muted(t, 0.55)} />
              )}
            </FadeBack>
          </div>
        )}
        <div style={{ position: 'absolute', top: 0, bottom: 0, right: 6, display: 'flex', alignItems: 'center' }}>
          <Reveal show={reveal}>
            <SidebarIconButton icon={N.x} size="sm" glyph={15} label="Dismiss" tooltip="Dismiss" onClick={() => setLeaveAsked(true)} />
          </Reveal>
        </div>
      </div>
      <TreeLines shape={tree} />
      {menu.at && (
        <ContextMenu at={menu.at} onClose={menu.close} testId="child-menu">
          <MenuItem id="open" label="Open" onSelect={() => openThread(thread.id)} />
          <MenuItem id="parent" icon={N.backToParent} label="Open parent" onSelect={() => thread.parent_thread_id && openThread(thread.parent_thread_id)} />
          {working && !delegated && thread.subagent?.capabilities?.stop !== false && (
            <MenuItem id="stop" icon={N.stop} label="Stop" onSelect={() => void getClient()?.call('tasks.stop', { thread_id: thread.id }).catch(() => {})} />
          )}
          {canStopDelegation(thread) && (
            <MenuItem id="stop-delegated" icon={N.stop} label="Stop" onSelect={() => void getClient()?.call('threads.interrupt', { thread_id: thread.id }).catch(() => {})} />
          )}
          {delegated && <MenuItem id="archive" icon={N.archive} label="Archive" onSelect={() => void archiveThread(thread.id)} />}
        </ContextMenu>
      )}
    </div>
  )
  return leaving ? (
    <div testId={`leaving-${thread.id}`}>
      <Leave height={32} onDone={() => dismissChild(thread.id)}>
        {body}
      </Leave>
    </div>
  ) : (
    <div>{body}</div>
  )
})

function dismissChild(id: string) {
  if (getNav().dismissed[id]) return
  setNav({ dismissed: { ...getNav().dismissed, [id]: true } })
}

export const CreateCoordinatorRow = memo(function CreateCoordinatorRow({ project }: { project: Project }) {
  const t = useTheme()
  return (
    <div style={{ paddingTop: 2, ...INSET }}>
      <div
        testId={`create-coordinator-${project.id}`}
        onClick={() => newThread(project.id, 'coordinator')}
        style={{ display: 'flex', alignItems: 'center', gap: 8, height: 28, paddingLeft: 32, paddingRight: 8, borderRadius: 8, cursor: 'pointer', hover: { backgroundColor: accent(t) }, ...pressRow(t, accent(t)) }}
      >
        <Icon source={N.users} size={12} color={resting(t)} />
        <Label color={resting(t)} truncate>
          Create coordinator
        </Label>
      </div>
    </div>
  )
})

export const MoreRow = memo(function MoreRow({ projectId, count, showAll, onToggle }: { projectId: string; count: number; showAll: boolean; onToggle: (id: string) => void }) {
  return (
    <div style={{ paddingTop: 2, ...INSET }}>
      <Button variant="ghost" size="sm" testId={`more-${projectId}`} onClick={() => onToggle(projectId)} style={{ alignSelf: 'flex-start', marginLeft: 24 }}>
        {showAll ? 'Show less' : `Show ${count} more`}
      </Button>
    </div>
  )
})

/** A space without projects (`spaces.md` §7.9): a compact `Empty`, left-aligned in the panel inset. */
export const EmptySpaceRow = memo(function EmptySpaceRow({ onlySpace }: { onlySpace: boolean }) {
  const t = useTheme()
  const onAddProject = useAddProject()
  return (
    <div testId="empty-space" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 10, paddingLeft: 16, paddingRight: 16, paddingTop: 8, paddingBottom: 8, minWidth: 0 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <Label color={t.text} size={13} lineHeight={19.5} weight={500}>{SPACE_COPY.emptyTitle}</Label>
        {!onlySpace && <Label color={t.textSecondary} size={12} lineHeight={18} style={{ minWidth: 0, flexShrink: 1 }}>{SPACE_COPY.emptyDescription}</Label>}
      </div>
      <Button size="sm" testId="empty-space-add" onClick={() => void onAddProject()}>{SPACE_COPY.emptyAction}</Button>
    </div>
  )
})

export const NoThreadsRow = memo(function NoThreadsRow() {
  const t = useTheme()
  return (
    <div style={{ paddingTop: 2, ...INSET }}>
      <div style={{ display: 'flex', alignItems: 'center', paddingLeft: 32, paddingRight: 8, paddingTop: 4, paddingBottom: 4 }}>
        <Label color={muted(t, 0.48)} lineHeight={20}>
          No threads yet
        </Label>
      </div>
    </div>
  )
})

/** The Recents disclosure (free chats). */
export const RecentsHeader = memo(function RecentsHeader({ open }: { open: boolean }) {
  const t = useTheme()
  return (
    <div style={{ paddingTop: 12, ...INSET }}>
      <div
        testId="recents"
        onClick={() => toggleProject(FREE_CHAT_PROJECT_ID)}
        style={{ display: 'flex', alignItems: 'center', gap: 4, height: 28, paddingLeft: 8, paddingRight: 8, borderRadius: 8, cursor: 'pointer', hover: { backgroundColor: accent(t) }, ...pressRow(t, accent(t)) }}
      >
        <Label color={muted(t, 0.58)}>Recents</Label>
        <Chevron open={open} size={12} color={muted(t, 0.65)} />
      </div>
    </div>
  )
})
