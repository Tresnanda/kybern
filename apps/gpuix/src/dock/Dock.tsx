// Native right dock. Only the chosen pane is mounted; the shell keeps it through
// its exit, just like App's thread panel. Each painted edge owns its radii.
//
// Motion (P3): the dock opens and closes on the desktop's width spring (stiffness 420, damping 42, mass 0.7) while its content
// fades (250 ms in, 150 ms out; paint-only); a pane switched to by pointer enters as `t-pane` (opacity, 4 px, scale 0.995;
// the terminal fades only, the preview's native web view is not moved); a tab added from the + menu grows in (opacity and
// scale 0.97, 150 ms) and a closed one leaves (120 ms) before the strip closes the gap. Shortcut toggles and keyboard tab
// changes are instant.
import { popAnimation } from '../kit/Pop.tsx'
import { motion, useGpuix, type PublicInstance } from '@gpuix/react'
import { useSidebarWidth, useWindowWidth } from '../shell/layout.ts'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Thread } from '../../../../packages/kybern-client/src/types.ts'
import { DOCK_ICONS } from './icons.ts'
import { Icon } from '../icons.tsx'
import { ISLAND } from '../MatrixLoader.tsx'
import { N } from '../nav/glyphs.ts'
import { Menu, MenuItem } from '../nav/overlay.tsx'
import { useNav } from '../nav/store.ts'
import { IconButton } from '../sidebar/rows.tsx'
import { useApp } from '../state.ts'
import { EASE_OUT, Label, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { Activity, isActiveTask, useRuntimeTasks } from './Activity.tsx'
import { Agents } from './Agents.tsx'
import { DiffPane } from './Diff.tsx'
import { Explorer } from './Explorer.tsx'
import { ProjectPane } from './Project.tsx'
import { PreviewPane } from '../preview/Preview.tsx'
import { TerminalPane } from '../terminal/Terminal.tsx'
import { ReviewPane } from './Review.tsx'
import { ArtifactsPane } from './Artifacts.tsx'
import { NotesPane } from './Notes.tsx'
import { TasksPane } from './Tasks.tsx'
import { DockEmpty } from './parts.tsx'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../kit/Empty.tsx'
import { pressTransform } from '../motion/press.ts'
import { DURATION, EASE, enterTransform } from '../motion/kit.tsx'
import { nextPresenceGeneration, presenceTransform } from '../motion/Presence.tsx'
import { useLeavingList } from '../composer/motion.tsx'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { treeMotionCapabilities } from './fileTreeMotion.ts'
import { leftSource } from '../drag/leave.ts'
import { beginTabDrag, isDraggingTab, consumeTabDrag, endTabPending, setTabContext, TabSlot, trackTabDrag } from './reorder.tsx'
import { chooseTab, closeTab, dockGeometry, finishDockDrag, moveDockDrag, setDock, startDockDrag, useDock, useDockDrag, type DockTab } from './store.ts'

/** The tab pill (`t-tabs-pill`): 250 ms smooth-out. */
const SLIDE = { duration: DURATION.fast, ease: [...EASE.smoothOut] as [number, number, number, number] }
/** The dock's width (`App.tsx`): the desktop's spring; an addon without physical springs gets the duration spring closest to it. */
const dockSlide = (physical: boolean) => physical ? { type: 'spring' as const, stiffness: 420, damping: 42, mass: 0.7 } : { type: 'spring' as const, duration: 0.3, bounce: 0 }
/** The spring settles in about 300 ms; the guard that releases the content after a close waits a little longer. */
const DOCK_EXIT_GUARD_MS = 420
const PANELS: { id: DockTab; label: string; icon: string; width: number }[] = [
  { id: 'agents', label: 'Agents', icon: N.users, width: 100 },
  { id: 'project', label: 'Project', icon: N.note, width: 104 },
  { id: 'activity', label: 'Activity', icon: DOCK_ICONS.activity, width: 104 },
  { id: 'changes', label: 'Diff', icon: DOCK_ICONS.changes, width: 80 },
  { id: 'review', label: 'Review', icon: N.pullRequest, width: 100 },
  { id: 'terminal', label: 'Terminal', icon: DOCK_ICONS.terminal, width: 112 },
  { id: 'artifacts', label: 'Artifacts', icon: DOCK_ICONS.artifacts, width: 110 },
  { id: 'explorer', label: 'Explorer', icon: DOCK_ICONS.explorer, width: 110 },
  { id: 'notes', label: 'Notes', icon: N.note, width: 96 },
  { id: 'tasks', label: 'Tasks', icon: N.tasks, width: 96 },
  { id: 'preview', label: 'Preview', icon: DOCK_ICONS.preview, width: 110 },
]

export function Dock({ sidebarOpen }: { sidebarOpen: boolean }) {
  const t = useTheme()
  const threadId = useApp((s) => s.selectedId)
  const page = useNav((s) => s.page)
  const settings = useNav((s) => s.settingsOpen)
  const dock = useDock(threadId)
  const open = dock.open && page === 'home' && !settings
  const [mounted, setMounted] = useState(open)
  const [mountedFor, setMountedFor] = useState(threadId)
  if (mountedFor !== threadId) { setMountedFor(threadId); setMounted(open) }
  if (open && !mounted) setMounted(true)
  const drag = useDockDrag()
  const still = REDUCED_MOTION || dock.instant || !!drag
  if (still && !open && mounted) setMounted(false)
  useEffect(() => {
    if (open || !mounted || still) return
    // GPUIX 0.10 can omit motionComplete when the final frame has zero width
    // inside a cached parent. A one-shot exit guard also releases the content.
    const timer = setTimeout(() => setMounted(false), DOCK_EXIT_GUARD_MS)
    return () => clearTimeout(timer)
  }, [open, mounted, still, threadId])
  if (!mounted && !open) return null
  return <DockShell key={threadId ?? 'home'} threadId={threadId} open={open} mounted={mounted} setMounted={setMounted} sidebarOpen={sidebarOpen} still={still} background={t.surface} />
}

function DockShell({ threadId, open, mounted, setMounted, sidebarOpen, still, background }: {
  threadId: string | null; open: boolean; mounted: boolean; setMounted: (value: boolean) => void; sidebarOpen: boolean; still: boolean; background: string
}) {
  const t = useTheme()
  // The shell's native resize subscription supplies width; geometry stays derived.
  const windowWidth = useWindowWidth()
  const sidebarWidth = useSidebarWidth()
  const dock = useDock(threadId)
  const geometry = dockGeometry(windowWidth, sidebarOpen ? sidebarWidth : 0, dock.width)
  const thread = useApp((s) => s.open.thread?.id === threadId ? s.open.thread : s.threads.find((th) => th.id === threadId))
  const { renderer } = useGpuix()
  const physical = !!renderer && treeMotionCapabilities(renderer).physical
  // The content fades with the width: in over 250 ms, out over 150 ms (`generation` follows `open`, so a reversal retargets).
  const phase = useRef({ open, generation: nextPresenceGeneration(), mounted: 0 })
  if (phase.current.mounted === 0) phase.current.mounted = phase.current.generation
  if (phase.current.open !== open) phase.current = { ...phase.current, open, generation: nextPresenceGeneration() }
  const fade = still ? undefined : presenceTransform({ show: open, enter: { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: DURATION.fast, ease: [...EASE.smoothOut] } }, exit: { to: { opacity: 0 }, duration: DURATION.quick }, generation: phase.current.generation, fresh: phase.current.generation === phase.current.mounted })
  return <motion.div {...{ testId: 'right-dock' }} initial={still ? false : { width: 0 }} animate={{ width: open ? geometry.width : 0 }} transition={still ? { duration: 0 } : dockSlide(physical)}
    onMotionComplete={() => setMounted(open)}
    style={{ display: 'flex', flexDirection: 'column', flexShrink: 0, height: '100%', minHeight: 0, overflow: 'hidden', position: geometry.overlay ? 'absolute' : 'relative', ...(geometry.overlay ? { top: 0, right: 0, bottom: 0, boxShadow: { offsetX: -8, offsetY: 0, blurRadius: 24, spreadRadius: 0, color: 'rgba(0, 0, 0, 0.16)' } } : {}), borderTopRightRadius: 12, borderBottomRightRadius: 12 }}>
    <div testId={geometry.overlay ? 'dock-overlay' : 'dock-inline'} paintTransform={fade} style={{ display: 'flex', flexDirection: 'column', width: geometry.width, height: '100%', flexShrink: 0, minHeight: 0, borderLeftWidth: 0.6, borderColor: t.borderLight, backgroundColor: background, borderTopRightRadius: 12, borderBottomRightRadius: 12 }}>
      {mounted && <DockContent key={threadId ?? 'home'} threadId={threadId} thread={thread ?? null} width={geometry.width} />}
    </div>
    <div testId="dock-resize" role="separator" aria-label="Resize right sidebar" tabIndex={0}
      onMouseDown={(event) => { if (event.button === 0 && event.x !== undefined) startDockDrag({ id: threadId, x: event.x, width: geometry.width, max: geometry.max }) }}
      onKeyDown={(event) => { if (event.key === 'left' || event.key === 'right') setDock(threadId, { width: Math.min(geometry.max, Math.max(416, geometry.width + (event.key === 'left' ? 24 : -24))) }) }}
      style={{ position: 'absolute', top: 4, bottom: 4, left: 0, width: 5, cursor: 'col-resize', hover: { backgroundColor: t.selected } }} />
  </motion.div>
}

function DockContent({ threadId, thread, width }: { threadId: string | null; thread: Thread | null; width: number }) {
  if (!thread) return <>
    <TabStrip threadId={threadId} width={width} coordinator={false} activeTasks={0} stats={[0, 0]} />
    <DockEmpty icon={N.panelRight} title="Open a thread" body="Open a thread to see its agents, activity and files." />
  </>
  return <ThreadDock key={thread.id} thread={thread} width={width} />
}

/**
 * Every panel closed. The desktop shows a bare "Add a panel with +." (`RightPanel.tsx`); the user asked for more, so this is the kit's
 * `Empty` (icon card, title, description) plus the `+` menu's panels as quick actions, from the same `PANELS` list and `chooseTab`,
 * so they stay in step with the menu. A deliberate divergence from the desktop.
 */
function NoPanels({ threadId, coordinator, instant }: { threadId: string; coordinator: boolean; instant: boolean }) {
  const t = useTheme()
  const panels = PANELS.filter((panel) => panel.id !== 'project' || coordinator)
  return (
    <Empty testId="dock-empty" style={{ padding: 24 }}>
      <EmptyHeader play={!instant}>
        <EmptyMedia variant="icon" icon={N.panelRight} />
        <EmptyTitle>No panels open</EmptyTitle>
        <EmptyDescription>Panels show a thread's activity, changes, files and more.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 6 }}>
        {panels.map((panel) => (
          <div key={panel.id} testId={`dock-empty-${panel.id}`} role="button" aria-label={`Open ${panel.label} panel`} onClick={() => chooseTab(threadId, panel.id)} paintTransform={pressTransform()}
            style={{ display: 'flex', alignItems: 'center', gap: 6, height: 28, paddingLeft: 8, paddingRight: 10, borderRadius: 8, cursor: 'pointer', borderWidth: 1, borderColor: t.v('--border'), hover: { backgroundColor: t.buttonSecondaryHover } }}>
            <Icon source={panel.icon} size={14} color={t.textSecondary} />
            <Label color={t.text} size={13}>{panel.label}</Label>
          </div>
        ))}
      </EmptyContent>
    </Empty>
  )
}

function ThreadDock({ thread, width }: { thread: Thread; width: number }) {
  const t = useTheme()
  const dock = useDock(thread.id)
  const tasks = useRuntimeTasks(thread.id)
  const [stats, setStats] = useState<[number, number]>([0, 0])
  const onStats = useCallback((adds: number, dels: number) => setStats((previous) => previous[0] === adds && previous[1] === dels ? previous : [adds, dels]), [])
  const tab = dock.tab === 'project' && !thread.coordinator_project_id ? dock.tabs.find((id) => id !== 'project') ?? null : dock.tab
  const keyboard = useNav((s) => s.keyboardNav)
  // `t-pane`: only a pane switched to after the dock was up, by pointer, enters (the first pane, keyboard and instant changes do not).
  const seen = useRef<DockTab | null | undefined>(undefined)
  const entering = useRef<DockTab | null>(null)
  if (seen.current !== tab) {
    entering.current = seen.current !== undefined && !dock.instant && !keyboard ? tab : null
    seen.current = tab
  }
  return <>
    <TabStrip threadId={thread.id} width={width} coordinator={!!thread.coordinator_project_id} activeTasks={tasks.tasks.filter(isActiveTask).length} stats={stats} />
    <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0, minWidth: 0, overflow: 'hidden', borderBottomRightRadius: 12 }}>
      {tab === null ? <NoPanels threadId={thread.id} coordinator={!!thread.coordinator_project_id} instant={dock.instant || keyboard} /> : <PaneEnter key={tab} tab={tab} play={entering.current === tab}>
        {tab === 'agents' ? <Agents thread={thread} />
        : tab === 'preview' ? <PreviewPane threadId={thread.id} />
        : tab === 'terminal' ? <TerminalPane threadId={thread.id} width={width} />
        : tab === 'review' ? <ReviewPane thread={thread} width={width} />
        : tab === 'artifacts' ? <ArtifactsPane thread={thread} />
        : tab === 'notes' ? <NotesPane thread={thread} />
        : tab === 'tasks' ? <TasksPane thread={thread} />
        : tab === 'activity' ? <Activity {...tasks} />
        : tab === 'changes' ? <DiffPane thread={thread} onStats={onStats} />
        : tab === 'explorer' ? <Explorer key={thread.project_id} projectId={thread.project_id} width={width} />
        : tab === 'project' && thread.coordinator_project_id ? <ProjectPane thread={thread} /> : null}
      </PaneEnter>}
    </div>
  </>
}

/**
 * The pane of the chosen tab. `play` (decided once per tab by the caller) enters it as `t-pane`: opacity 0 → 1, 4 px low and
 * scale 0.995 → 1, 250 ms smooth-out, paint-only. The terminal only fades (its text must not shift), and the preview never
 * moves: its page is a native web view that a paint transform cannot carry. The outgoing pane unmounts at once (GPUIX releases it).
 */
function PaneEnter({ tab, play, children }: { tab: DockTab; play: boolean; children: React.ReactNode }) {
  const transform = !play || !PATCHED_NATIVE || tab === 'preview' ? undefined
    : tab === 'terminal' ? { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: DURATION.quick, ease: [...EASE.out] as [number, number, number, number] } }
    : enterTransform('pane')
  return <div paintTransform={transform} style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0, minWidth: 0, overflow: 'hidden' }}>{children}</div>
}

/** A tab that was just added: it grows in from opacity 0 and scale 0.97 over 150 ms (`--ease-out`); the others render plainly. */
function TabEnter({ fresh, children }: { fresh: boolean; children: React.ReactNode }) {
  const enter = fresh && PATCHED_NATIVE
    ? { initial: REDUCED_MOTION ? { opacity: 0 } : { opacity: 0, scale: 0.97 }, animate: REDUCED_MOTION ? { opacity: 1 } : { opacity: 1, scale: 1 }, transition: { duration: DURATION.quick, ease: [...EASE.out] as [number, number, number, number] } }
    : undefined
  return <div paintTransform={enter} style={{ display: 'flex', alignItems: 'center', height: 28, flexShrink: 0 }}>{children}</div>
}

let tabLeaveGeneration = 8_000_000
/** A closed tab: it fades and shrinks to 0.97 over 120 ms (`--ease-out`), non-interactive, then `onDone` unmounts it and the strip closes the gap. */
function TabLeave({ onDone, children }: { onDone: () => void; children: React.ReactNode }) {
  const generation = useMemo(() => ++tabLeaveGeneration, [])
  return <div paintTransform={{ initial: { opacity: 1, scale: 1 }, animate: REDUCED_MOTION ? { opacity: 0 } : { opacity: 0, scale: 0.97 }, transition: { duration: 0.12, ease: [...EASE.out] as [number, number, number, number] }, generation }}
    onMotionComplete={(event) => { if (event.motionGeneration === generation) onDone() }} style={{ display: 'flex', alignItems: 'center', height: 28, flexShrink: 0, pointerEvents: 'none' }}>{children}</div>
}

function TabStrip({ threadId, width, coordinator, activeTasks, stats }: { threadId: string | null; width: number; coordinator: boolean; activeTasks: number; stats: [number, number] }) {
  const t = useTheme()
  const dock = useDock(threadId)
  const keyboard = useNav((s) => s.keyboardNav)
  const { renderer } = useGpuix()
  const scroll = useRef<PublicInstance | null>(null)
  const tabRefs = useRef(new Map<DockTab, PublicInstance>())
  const rowRef = useRef<PublicInstance | null>(null)
  const panels = PANELS.filter((panel) => panel.id !== 'project' || coordinator)
  const liveTabs = useMemo(() => dock.tabs.flatMap((id) => { const panel = PANELS.filter((p) => p.id !== 'project' || coordinator).find((p) => p.id === id); return panel ? [panel] : [] }), [dock.tabs, coordinator])
  // A closed tab stays in the strip for its 120 ms exit (pointer closes only), so the gap closes after it has faded.
  const [entries, gone] = useLeavingList(liveTabs, () => !keyboard && !dock.instant)
  const tabs = entries.map((entry) => entry.item)
  const tab = dock.tab === 'project' && !coordinator ? liveTabs[0]?.id ?? null : dock.tab
  const widths = tabs.map((panel) => panel.width + (panel.id === 'activity' && activeTasks ? 18 : panel.id === 'changes' && stats[0] + stats[1] ? 65 : 0))
  const index = tabs.findIndex((p) => p.id === tab)
  const left = widths.slice(0, Math.max(0, index)).reduce((n, value) => n + value + 4, 0)
  const selectedWidth = widths[index] ?? 0
  const liveWidths = widths.filter((_, i) => !entries[i]!.leaving)
  setTabContext({ threadId, ids: liveTabs.map((p) => p.id), widths: liveWidths, icons: liveTabs.map((p) => p.icon), labels: liveTabs.map((p) => p.label), scroll: scroll.current, row: rowRef.current })
  const select = (id: DockTab, instant = false) => { setDock(threadId, { instant }); chooseTab(threadId, id) }
  useEffect(() => {
    // One post-commit scroll so a newly added chip is brought into view.
    const timer = setTimeout(() => { if (scroll.current) renderer?.scrollTo?.(scroll.current.id, -Math.max(0, left + selectedWidth - (width - 78)), 0) }, 16)
    return () => clearTimeout(timer)
  }, [left, selectedWidth, width, renderer])
  return <div {...ISLAND} testId="dock-tabs" style={{ display: 'flex', width: '100%', height: 46, alignItems: 'center', gap: 4, paddingLeft: 6, paddingRight: 6, flexShrink: 0, backgroundColor: t.surface, borderTopRightRadius: 12, borderBottomWidth: 1, borderColor: t.surfaceDivider }}>
    <div ref={scroll} style={{ display: 'flex', alignItems: 'center', flexGrow: 1, minWidth: 0, height: 32, overflowX: 'scroll', overflowY: 'hidden' }}>
      <div ref={rowRef} style={{ display: 'flex', alignItems: 'center', position: 'relative', gap: 4, height: 28, flexShrink: 0 }}>
        {tab && <motion.div initial={false} animate={{ left, width: selectedWidth }} transition={REDUCED_MOTION || keyboard || dock.instant ? { duration: 0 } : SLIDE}
          style={{ position: 'absolute', top: 0, height: 28, borderRadius: 8, backgroundColor: t.buttonSecondary, pointerEvents: 'none' }} />}
        {entries.map((entry, i) => { const panel = entry.item; const chip = (<div style={{ display: 'flex', alignItems: 'center', height: 28, width: widths[i], flexShrink: 0, borderRadius: 8, hover: { backgroundColor: t.buttonSecondaryHover } }}>
          <div ref={(node) => { if (node) tabRefs.current.set(panel.id, node); else tabRefs.current.delete(panel.id) }} testId={`dock-tab-${panel.id}`} role="tab" aria-selected={panel.id === tab} tabIndex={panel.id === tab ? 0 : -1} onClick={() => { if (!consumeTabDrag(panel.id)) select(panel.id) }}
            onMouseDown={(e) => { const node = tabRefs.current.get(panel.id); beginTabDrag(panel.id, e, renderer, node && renderer?.getElementBounds?.(node.id) ? { ...renderer.getElementBounds(node.id)!, width: widths[i]!, height: 28 } : null) }}
            onMouseMove={trackTabDrag} onMouseUp={endTabPending} onMouseLeave={(e) => { if (!leftSource(e, renderer)) return; if (!isDraggingTab()) trackTabDrag(e, true); endTabPending() }}
            onKeyDown={(event) => {
              if (event.key === 'left' || event.key === 'right') {
                const at = liveTabs.findIndex((p) => p.id === panel.id)
                const next = liveTabs[(at + (event.key === 'left' ? liveTabs.length - 1 : 1)) % liveTabs.length]!.id
                select(next, true)
                const node = tabRefs.current.get(next)
                if (node) renderer?.focusElement?.(node.id)
              }
              if (event.key === 'enter' || event.key === 'space') select(panel.id, true)
            }}
            paintTransform={pressTransform()}
            style={{ display: 'flex', alignItems: 'center', gap: 6, flexGrow: 1, minWidth: 0, height: 28, paddingLeft: 6, cursor: 'pointer', borderRadius: 8 }}>
            <Icon source={panel.icon} size={14} color={t.textSecondary} />
            <Label color={panel.id === tab ? t.text : t.textSecondary} size={13}>{panel.label}</Label>
            {panel.id === 'activity' && activeTasks > 0 && <Label key={activeTasks} color={t.textSecondary} size={10} paintAnimation={popAnimation()}>{String(activeTasks)}</Label>}
            {panel.id === 'changes' && stats[0] + stats[1] > 0 && <div key={`${stats[0]}:${stats[1]}`} style={{ display: 'flex', gap: 3 }}><Label color={t.green} size={10} paintAnimation={popAnimation()}>{`+${stats[0]}`}</Label><Label color={t.red} size={10} paintAnimation={popAnimation()}>{`−${stats[1]}`}</Label></div>}
          </div>
          <IconButton press icon={N.x} glyph={12} size={24} label={`Close ${panel.label} panel`} onClick={() => closeTab(threadId, panel.id)} testId={`dock-tab-close-${panel.id}`} />
        </div>)
          return entry.leaving ? <TabLeave key={panel.id} onDone={() => gone(panel.id)}>{chip}</TabLeave> : <TabEnter key={panel.id} fresh={entry.fresh}><TabSlot id={panel.id}>{chip}</TabSlot></TabEnter>
        })}
      </div>
    </div>
    <Menu align="end" minWidth={176} testId="dock-add" trigger={() => <IconButton icon={N.plus} size={28} label="Add panel" />}>
      {panels.map((panel) => <MenuItem key={panel.id} id={panel.id} icon={panel.icon} label={panel.label} shortcut={dock.tabs.includes(panel.id) ? 'Open' : undefined} testId={`dock-add-${panel.id}`} onSelect={() => select(panel.id, keyboard)} />)}
    </Menu>
    <IconButton icon={N.panelRight} size={28} label="Collapse panel" tooltip="Collapse panel (⌘J)" onClick={() => setDock(threadId, { open: false, instant: false })} testId="dock-collapse" />
  </div>
}

/** Capture drag movement across the whole window, including the chat and rail. */
export function DockResizeCapture() {
  const drag = useDockDrag()
  if (!drag) return null
  return <div testId="dock-resize-capture" onMouseMove={(event) => {
    if (event.pressedButton !== 0) { finishDockDrag(); return }
    if (event.x !== undefined) moveDockDrag(event.x)
  }} onMouseUp={finishDockDrag} onMouseDownOutside={finishDockDrag}
    style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, cursor: 'col-resize' }} />
}
