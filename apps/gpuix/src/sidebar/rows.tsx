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
import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import { childState, canStopDelegation } from '../../../../packages/kybern-client/src/delegations.ts'
import { SUBAGENT_SIDEBAR_HOLD_MS, subagentThreadPhase, type SubagentPhase } from '../../../../packages/kybern-client/src/subagents.ts'
import { FREE_CHAT_PROJECT_ID, type Project, type Thread, type ThreadActivityState } from '../../../../packages/kybern-client/src/types.ts'
import { Icon } from '../icons.tsx'
import { MatrixLoader } from '../MatrixLoader.tsx'
import { addProject, archiveThread, errorText, removeProject, updateThread } from '../nav/actions.ts'
import { N } from '../nav/glyphs.ts'
import { newThread, openThread } from '../nav/history.ts'
import { ContextMenu, Menu, MenuItem, MenuLabel, MenuSeparator, muted, Tip } from '../nav/overlay.tsx'
import { DEFAULT_FILTER, getNav, setNav, useNav } from '../nav/store.ts'
import { getClient, getState, toggleProject as toggleProjectState } from '../state.ts'
import { ink, Label, ProviderMark, useTheme } from '../ui.tsx'
import type { Theme } from '../theme.ts'
import { beginProjectDrag, consumeProjectDrag, endProjectPending, trackProjectDrag } from './reorder.tsx'
import { filterSummary, isFiltering, providerLabel, threadAgents } from './model.ts'
import { popAnimation, usePopOnChange } from '../kit/Pop.tsx'
import { pressTransform } from '../motion/press.ts'
import { FadeBack, Leave, markDisclosure, MarqueeLabel, PadTween, Reveal, TitleSwap } from './motion.tsx'

/** Open or close a project (or Recents); the rows it adds or removes animate as a block. */
function toggleProject(id: string) {
  markDisclosure()
  toggleProjectState(id)
}

/** `Reveal` unless the content is pinned on screen (an active filter keeps its toolbar shown). */
function RevealIf({ play, children }: { play: boolean; children: ReactNode }) {
  return play ? <Reveal>{children}</Reveal> : <>{children}</>
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

export const accent = (t: Theme) => t.v('--sidebar-accent')
export const accentActive = (t: Theme) => t.v('--sidebar-accent-active')
/** `text-foreground/95`: every resting sidebar label and its icon. */
export const resting = (t: Theme) => ink(t, 0.95)

/** amber-500 / dark:amber-300/90 (`StatusGlyph` pending dot). */
const amberDot = (t: Theme) => (t.variant === 'dark' ? 'rgba(255, 210, 48, 0.9)' : '#fe9a00')
/** amber-600 / dark:amber-300/90 (the "Pending" word). */
const amberText = (t: Theme) => (t.variant === 'dark' ? 'rgba(255, 210, 48, 0.9)' : '#e17100')

/**
 * Hover for a row and the controls it reveals. GPUIX gives a positioned child
 * its own hitbox that occludes the row, so moving onto a revealed button sends
 * the row `mouseLeave`; the buttons report their own hover through `keep` so
 * the row stays revealed while the pointer is on any of them.
 */
function useHover() {
  const [self, setSelf] = useState(false)
  const [kept, setKept] = useState(0)
  return {
    hover: self || kept > 0,
    bind: {
      onMouseEnter: () => setSelf(true),
      onMouseLeave: () => setSelf(false),
    },
    /** For each revealed control: true on enter, false on leave (balanced, so a count). */
    keep: (on: boolean) => setKept((n) => Math.max(0, n + (on ? 1 : -1))),
  }
}

/** Right-click opens a context menu at the pointer. */
function useContextMenu() {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  return {
    at,
    close: () => setAt(null),
    onAuxClick: (e: { isRightClick?: boolean; button?: number; x?: number; y?: number }) => {
      if (e.isRightClick || e.button === 2) setAt({ x: e.x ?? 0, y: e.y ?? 0 })
    },
  }
}

/**
 * `SidebarIconButton`: a square, `rounded-sm` button whose glyph brightens on
 * hover (`text-muted-foreground/60 hover:text-foreground/82`).
 */
export function IconButton({
  icon,
  size = 20,
  glyph = 14,
  color,
  hoverColor,
  label,
  tooltip,
  tooltipSide = 'top',
  onClick,
  active,
  radius = 6,
  testId,
  children,
  onHover,
  press = false,
}: {
  onHover?: (on: boolean) => void
  /** Desktop `press` (scale 0.97 on :active): only where the desktop control has it; tooltip/menu triggers do not. */
  press?: boolean
  icon: string
  size?: number
  glyph?: number
  color?: string
  hoverColor?: string
  label: string
  tooltip?: string | string[]
  tooltipSide?: 'top' | 'bottom'
  onClick?: () => void
  active?: boolean
  radius?: number
  testId?: string
  children?: ReactNode
}) {
  const t = useTheme()
  const { hover, bind } = useHover()
  const rest = color ?? muted(t, 0.6)
  const button = (
    <div
      testId={testId}
      aria-label={label}
      role="button"
      onMouseEnter={() => {
        bind.onMouseEnter()
        onHover?.(true)
      }}
      onMouseLeave={() => {
        bind.onMouseLeave()
        onHover?.(false)
      }}
      onClick={onClick}
      paintTransform={pressTransform(press && !!onClick)}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        borderRadius: radius,
        flexShrink: 0,
        cursor: 'pointer',
        position: 'relative',
        ...(active ? { backgroundColor: accentActive(t) } : {}),
        hover: { backgroundColor: active ? accentActive(t) : t.buttonSecondaryHover },
      }}
    >
      <Icon source={icon} size={glyph} color={hover || active ? (hoverColor ?? ink(t, 0.82)) : rest} />
      {children}
    </div>
  )
  if (!tooltip) return button
  const [text, ...keys] = Array.isArray(tooltip) ? tooltip : [tooltip]
  return (
    <Tip label={text!} shortcut={keys.length ? keys : undefined} side={tooltipSide} size={size}>
      {button}
    </Tip>
  )
}

/** `DisclosureChevron`: chevron-right, turned down when open (instant). */
export function Chevron({ open, size = 14, color }: { open: boolean; size?: number; color: string }) {
  return <Icon source={open ? N.chevronDown : N.chevronRight} size={size} color={color} />
}

export function Dot({ color }: { color: string }) {
  return <div style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color, flexShrink: 0 }} />
}

/** `StatusGlyph`: pending, working, failed, monitoring, unread, in that order. */
export function StatusGlyph({ status, activity, unread }: { status: Thread['status'] | null; activity?: ThreadActivityState; unread?: boolean }) {
  const t = useTheme()
  if (status === 'awaiting-approval') return <Dot color={amberDot(t)} />
  if (status === 'running' || activity === 'working') return <MatrixLoader cycle={1600} />
  if (status === 'failed') return <Dot color={t.red} />
  if (activity === 'monitoring') return <Icon source={N.clock} size={12} color={muted(t, 0.75)} />
  if (unread) return <Dot color={t.link} />
  return null
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

/** Vertical guides at x = 17 + 20·level, one per nesting level. */
function Guides({ depth }: { depth: number }) {
  const t = useTheme()
  if (depth === 0) return null
  return (
    <>
      {Array.from({ length: depth }, (_, level) => (
        <div
          key={level}
          style={{ position: 'absolute', top: -2, bottom: 0, left: 17 + level * 20, width: 1, backgroundColor: ink(t, 0.15), pointerEvents: 'none' }}
        />
      ))}
    </>
  )
}

/** The expand control for a row's nested children (`size-6` at 5 + 20·depth). */
function ChildToggle({ depth, open, onToggle, label, onHover, testId }: { depth: number; open: boolean; onToggle: () => void; label: string; onHover: (on: boolean) => void; testId?: string }) {
  const t = useTheme()
  const { hover, bind } = useHover()
  return (
    <div
      testId={testId}
      aria-label={label}
      role="button"
      onMouseEnter={() => {
        bind.onMouseEnter()
        onHover(true)
      }}
      onMouseLeave={() => {
        bind.onMouseLeave()
        onHover(false)
      }}
      onClick={onToggle}
      style={{ position: 'absolute', left: 5 + depth * 20, top: 2, width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, cursor: 'pointer' }}
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

// ---- section label ("Projects", with filter and add on hover) ----

export const SectionLabel = memo(function SectionLabel() {
  const t = useTheme()
  const { hover, bind, keep } = useHover()
  const filter = useNav((s) => s.filter)
  const threads = useNav(() => getState().threads)
  const [menuOpen, setMenuOpen] = useState(false)
  const onAddProject = useAddProject()
  const filtering = isFiltering(filter)
  const summaryPop = usePopOnChange(filtering)
  const agents = threadAgents(threads, filter)
  const shown = hover || filtering || menuOpen
  return (
    <div style={{ paddingTop: 10, paddingBottom: 4, ...INSET }}>
      <div {...bind} style={{ position: 'relative', display: 'flex', alignItems: 'center', height: 28, paddingLeft: 8, paddingRight: 76, gap: 6 }}>
        <Label color={muted(t, 0.58)}>Projects</Label>
        {filtering && (
          <>
            <Label color={muted(t, 0.58)}>·</Label>
            <Label color={ink(t, 0.7)} truncate paintAnimation={summaryPop ? popAnimation() : undefined}>
              {filterSummary(filter)}
            </Label>
          </>
        )}
        {shown && (
          <div onMouseEnter={() => keep(true)} onMouseLeave={() => keep(false)} style={{ position: 'absolute', top: 4, right: 6, display: 'flex', alignItems: 'center' }}>
            <RevealIf play={!filtering}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Menu
              open={menuOpen}
              onOpenChange={setMenuOpen}
              align="end"
              minWidth={192}
              testId="sidebar-filter"
              trigger={() => <IconButton icon={N.filter} label="Filter threads" tooltip={menuOpen ? undefined : 'Filter threads'} active={filtering} onHover={keep} />}
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
            <IconButton icon={N.plus} label="Add project" tooltip="Add project" onClick={() => void onAddProject()} testId="add-project" onHover={keep} />
            </div>
            </RevealIf>
          </div>
        )}
      </div>
    </div>
  )
})

/** Empty states under "Projects". */
export const MessageRow = memo(function MessageRow({ text, clearFilter }: { text: string; clearFilter?: boolean }) {
  const t = useTheme()
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 6, paddingLeft: 14, paddingRight: 14, paddingTop: 8, paddingBottom: 8 }}>
      <Label color={muted(t, clearFilter ? 0.6 : 0.48)}>{text}</Label>
      {clearFilter && (
        <div onClick={() => setNav({ filter: DEFAULT_FILTER })} style={{ cursor: 'pointer' }}>
          <Label color={ink(t, 0.85)} style={{ textDecoration: 'underline' }}>
            Show all threads
          </Label>
        </div>
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
  const { hover, bind, keep } = useHover()
  const menu = useContextMenu()
  const { renderer } = useGpuix()
  const headerRef = useRef<PublicInstance | null>(null)
  const move = (offset: -1 | 1) => {
    const visible = getState()
      .projects.map((p) => p.id)
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
      <div style={{ position: 'relative' }}>
        <div
          testId={`project-${project.id}`}
          ref={headerRef}
          {...bind}
          onMouseDown={(e) => beginProjectDrag(project.id, e, renderer, (headerRef.current && renderer?.getElementBounds?.(headerRef.current.id)) || null)}
          onMouseMove={trackProjectDrag}
          onMouseUp={endProjectPending}
          onMouseLeave={(e) => { trackProjectDrag(e, true); endProjectPending(); bind.onMouseLeave() }}
          onAuxClick={menu.onAuxClick}
          onClick={() => {
            if (consumeProjectDrag(project.id)) return
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
          }}
        >
          <div style={{ display: 'flex', width: 16, height: 16, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            {!hover && <Icon source={open ? N.folderOpen : N.folder} size={16} color={resting(t)} />}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexGrow: 1, minWidth: 0 }}>
            <Label color={active ? t.text : resting(t)} truncate>
              {project.name}
            </Label>
            {hasDraft && <DraftMarker />}
            <PadTween width={hover ? ACTIONS_PAD - 8 : 0} cancelGap={8} />
          </div>
          {!open && status && !hover && (
            <div style={{ display: 'flex', minWidth: 26, justifyContent: 'flex-end', alignItems: 'center', flexShrink: 0 }}>
              <StatusGlyph status={status} activity={activity} />
            </div>
          )}
        </div>
        {hover && (
          <>
            {/* The folder gives way to the disclosure control on hover. */}
            <div
              testId={`project-toggle-${project.id}`}
              role="button"
              aria-label={open ? 'Collapse' : 'Expand'}
              onClick={() => toggleProject(project.id)}
              onMouseEnter={() => keep(true)}
              onMouseLeave={() => keep(false)}
              style={{ position: 'absolute', left: 8, top: 6, width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, cursor: 'pointer' }}
            >
              <Reveal slide={false}>
                <Chevron open={open} color={ink(t, 0.8)} />
              </Reveal>
            </div>
            <div onMouseEnter={() => keep(true)} onMouseLeave={() => keep(false)} style={{ position: 'absolute', top: 4, right: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Reveal>
                <IconButton icon={N.newThread} label="New thread" tooltip="New thread" onClick={() => newThread(project.id)} testId={`project-new-${project.id}`} onHover={keep} />
              </Reveal>
            </div>
          </>
        )}
      </div>
      {menu.at && (
        <ContextMenu at={menu.at} onClose={menu.close} testId="project-menu">
          <MenuItem id="new" icon={N.newThread} label="New thread" onSelect={() => newThread(project.id)} />
          <MenuItem id="resume" icon={N.clock} label="Resume session" onSelect={() => setNav({ sessions: { projectId: project.id } })} />
          {(canMoveUp || canMoveDown) && (
            <>
              <MenuSeparator />
              <MenuItem id="up" icon={N.arrowUp} label="Move up" disabled={!canMoveUp} onSelect={() => move(-1)} />
              <MenuItem id="down" icon={N.arrowDown} label="Move down" disabled={!canMoveDown} onSelect={() => move(1)} />
            </>
          )}
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
  selected: boolean
  activity: ThreadActivityState | undefined
  unread: boolean
  hasDraft: boolean
  onToggleChildren: (id: string, open: boolean) => void
}) {
  const t = useTheme()
  const { hover, bind, keep } = useHover()
  const menu = useContextMenu()
  const [renaming, setRenaming] = useState(false)
  const [title, setTitle] = useState(thread.title)
  const splitRoot = useSplitRoot(), focusedPane = useFocusedPane()
  const inSplit = collectThreadPanes(splitRoot).some((pane) => pane.threadId === thread.id)
  const { renderer } = useGpuix()
  const rowRef = useRef<PublicInstance | null>(null)
  const hasGlyph = thread.status !== 'idle' || !!activity || unread
  const reveal = hover && !renaming
  const pendingPop = usePopOnChange(thread.status === 'awaiting-approval')
  const wasRevealed = useWasRevealed(reveal)
  const commitRename = () => {
    setRenaming(false)
    const next = title.trim()
    if (next && next !== thread.title) void updateThread(thread.id, { title: next }).catch((e) => console.error('[sidebar] Unable to rename:', errorText(e)))
    else setTitle(thread.title)
  }
  return (
    <div style={{ paddingTop: 2, ...INSET }}>
      <div style={{ position: 'relative' }}>
        <Guides depth={depth} />
        <div
          testId={`thread-${thread.id}`}
          ref={rowRef}
          onMouseDown={e => beginThreadDrag(thread.id, e, () => renderer?.clearSelection?.(), { title: thread.title || 'Untitled', kind: thread.provider.kind, bounds: () => (rowRef.current ? renderer?.getElementBounds?.(rowRef.current.id) : null) ?? null })}
          onMouseMove={trackThreadDrag}
          onMouseUp={finishSplitDrag}
          {...bind}
          onMouseLeave={bind.onMouseLeave}
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
                style={{ flexGrow: 1, minWidth: 0, height: 20, paddingLeft: 4, paddingRight: 4, borderRadius: 4, borderWidth: 1, borderColor: t.v('--ring'), backgroundColor: t.surface, color: t.text, fontSize: 14 }}
              />
            ) : (
              <TitleSwap text={thread.coordinator_project_id ? 'Open coordinator' : thread.title || 'Untitled'}>
                <MarqueeLabel hover={hover} text={thread.coordinator_project_id ? 'Open coordinator' : thread.title || 'Untitled'} color={selected ? t.text : resting(t)} />
              </TitleSwap>
            )}
            {hasDraft && !renaming && <DraftMarker />}
            {thread.status === 'awaiting-approval' && (
              <Label color={amberText(t)} size={10} weight={500} style={{ flexShrink: 0 }} paintAnimation={pendingPop ? popAnimation() : undefined}>
                Pending
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
            onHover={keep}
            testId={`children-${thread.id}`}
            label={`${childrenOpen ? 'Collapse' : 'Expand'} ${childCount} nested ${childCount === 1 ? 'thread' : 'threads'} of ${thread.title || 'Untitled'}`}
          />
        )}
        <div onMouseEnter={() => keep(true)} onMouseLeave={() => keep(false)} style={{ position: 'absolute', top: 0, bottom: 0, right: 6, display: 'flex', alignItems: 'center' }}>
          {reveal ? (
            <Reveal>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <IconButton
                icon={thread.pinned ? N.pinFilled : N.pin}
                glyph={15}
                color={muted(t, 0.34)}
                label={thread.pinned ? 'Unpin' : 'Pin'}
                onHover={keep}
                testId={`pin-${thread.id}`}
                onClick={() => void updateThread(thread.id, { pinned: !thread.pinned }).catch((e) => console.error('[sidebar] Unable to pin:', errorText(e)))}
              />
              <IconButton
                icon={N.archive}
                glyph={15}
                color={muted(t, 0.42)}
                hoverColor={ink(t, 0.89)}
                label="Archive"
                onHover={keep}
                testId={`archive-${thread.id}`}
                onClick={() => void archiveThread(thread.id).catch((e) => console.error('[sidebar] Unable to archive:', errorText(e)))}
              />
            </div>
            </Reveal>
          ) : (
            (hasGlyph || thread.pinned) && (
              <FadeBack play={wasRevealed} style={{ width: 15 }}>
                {hasGlyph ? (
                  <StatusGlyph status={thread.status} activity={activity} unread={unread} />
                ) : (
                  <Icon source={N.pinFilled} size={12} color={muted(t, 0.34)} />
                )}
              </FadeBack>
            )
          )}
        </div>
      </div>
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
function rowPhase(thread: Thread): SubagentPhase {
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
  selected,
  onToggleChildren,
}: {
  thread: Thread
  depth: number
  childCount: number
  childrenOpen: boolean
  selected: boolean
  onToggleChildren: (id: string, open: boolean) => void
}) {
  const t = useTheme()
  const { hover, bind, keep } = useHover()
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
  const pendingPop = usePopOnChange(thread.status === 'awaiting-approval')
  const wasRevealed = useWasRevealed(reveal)
  const body = (
    <div style={{ paddingTop: 3, paddingBottom: 1, ...INSET }}>
      <div style={{ position: 'relative' }}>
        <Guides depth={level} />
        <div
          testId={`child-${thread.id}`}
          ref={rowRef}
          onMouseDown={e => beginThreadDrag(thread.id, e, () => renderer?.clearSelection?.(), { title: thread.title || 'Untitled', kind: thread.provider.kind, bounds: () => (rowRef.current ? renderer?.getElementBounds?.(rowRef.current.id) : null) ?? null })}
          onMouseMove={trackThreadDrag}
          onMouseUp={finishSplitDrag}
          {...bind}
          onMouseLeave={bind.onMouseLeave}
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
          }}
        >
          <div style={{ display: 'flex', width: 12, height: 12, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <ProviderMark kind={thread.provider.kind} size={12} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexGrow: 1, minWidth: 0 }}>
            {/* A little quieter than its parent, so the parent stays dominant. */}
            <MarqueeLabel hover={hover} text={thread.title || (delegated ? 'Agent' : 'Subagent')} color={selected ? t.text : ink(t, 0.82)} />
            {thread.status === 'awaiting-approval' && (
              <Label color={amberText(t)} size={10} weight={500} style={{ flexShrink: 0 }} paintAnimation={pendingPop ? popAnimation() : undefined}>
                Pending
              </Label>
            )}
          </div>
        </div>
        {childCount > 0 && (
          <ChildToggle
            depth={level}
            open={childrenOpen}
            onToggle={() => onToggleChildren(thread.id, !childrenOpen)}
            onHover={keep}
            testId={`children-${thread.id}`}
            label={`${childrenOpen ? 'Collapse' : 'Expand'} ${childCount} nested ${delegated ? 'agent' : 'subagent'}${childCount === 1 ? '' : 's'}`}
          />
        )}
        {/* No glyph while it works: its presence says so, and the parent shows the loader. */}
        <div onMouseEnter={() => keep(true)} onMouseLeave={() => keep(false)} style={{ position: 'absolute', top: 0, bottom: 0, right: 6, display: 'flex', alignItems: 'center' }}>
          {reveal ? (
            <Reveal>
              <IconButton icon={N.x} glyph={15} color={muted(t, 0.45)} hoverColor={ink(t, 0.89)} label="Dismiss" tooltip="Dismiss" onClick={() => setLeaveAsked(true)} onHover={keep} />
            </Reveal>
          ) : (
            !working && (
              <FadeBack play={wasRevealed} style={{ width: 15 }} testId={`child-result-${thread.id}`}>
                {phase === 'failed' ? (
                  <Dot color={t.red} />
                ) : phase === 'stopped' ? (
                  <Icon source={N.stop} size={8} color={muted(t, 0.45)} />
                ) : (
                  <Icon source={N.check} size={12} color={muted(t, 0.55)} />
                )}
              </FadeBack>
            )
          )}
        </div>
      </div>
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
        style={{ display: 'flex', alignItems: 'center', gap: 8, height: 28, paddingLeft: 32, paddingRight: 8, borderRadius: 8, cursor: 'pointer', hover: { backgroundColor: accent(t) } }}
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
  const t = useTheme()
  const { hover, bind } = useHover()
  return (
    <div style={{ paddingTop: 2, ...INSET }}>
      <div testId={`more-${projectId}`} {...bind} onClick={() => onToggle(projectId)} style={{ display: 'flex', alignItems: 'center', height: 28, paddingLeft: 32, paddingRight: 8, cursor: 'pointer' }}>
        <Label color={hover ? t.text : muted(t, 0.79)} truncate>
          {showAll ? 'Show less' : `Show ${count} more`}
        </Label>
      </div>
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
        style={{ display: 'flex', alignItems: 'center', gap: 4, height: 28, paddingLeft: 8, paddingRight: 8, borderRadius: 8, cursor: 'pointer', hover: { backgroundColor: accent(t) } }}
      >
        <Label color={muted(t, 0.58)}>Recents</Label>
        <Chevron open={open} size={12} color={muted(t, 0.65)} />
      </div>
    </div>
  )
})
