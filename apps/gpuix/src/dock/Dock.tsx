// Native right dock. Only the chosen pane is mounted; the shell keeps it through
// its exit, just like App's thread panel. Each painted edge owns its radii.
//
// Motion (P3): the dock opens and closes on a 300 ms critically damped spring (the desktop's 420/42/0.7 spring, see `dockSlide`) while its content
// fades (250 ms in, 150 ms out; paint-only); a pane switched to by pointer enters as `t-pane` (opacity, 4 px, scale 0.995);
// the strip is the kit `Tabs` (its own open and close motion). Shortcut toggles and keyboard tab changes are instant.
// Since ADE-54 the dock holds navigational lists only; what they list opens as a tab beside the chat (`tabs/`).
import { toast } from '../shell/toasts.tsx'
import { errorText } from '../nav/actions.ts'
import { popAnimation } from '../kit/Pop.tsx'
import { motion, useGpuix, type PublicInstance } from '@gpuix/react'
import { useSidebarWidth, useWindowWidth } from '../shell/layout.ts'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Thread } from '../../../../packages/kybern-client/src/types.ts'
import { DOCK_ICONS } from './icons.ts'
import { Icon } from '../icons.tsx'
import { ISLAND } from '../MatrixLoader.tsx'
import { N } from '../nav/glyphs.ts'
import { Menu, MenuItem, MenuLabel, MenuSeparator, Tip } from '../nav/overlay.tsx'
import { Tabs, type TabsItem } from '../kit/Tabs.tsx'
import { openTab } from '../tabs/open.ts'
import { useNav } from '../nav/store.ts'
import { IconButton } from '../sidebar/rows.tsx'
import { IconButton as KitIconButton } from '../kit/IconButton.tsx'
import { PickerChip } from '../kit/PickerChip.tsx'
import { threadClient, useApp } from '../state.ts'
import { EASE_OUT, Label, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { Activity, isActiveTask, useRuntimeTasks } from './Activity.tsx'
import { Agents } from './Agents.tsx'
import { DiffPane } from './Diff.tsx'
import { Explorer } from './Explorer.tsx'
import { ProjectPane } from './Project.tsx'
import { MapPane } from './Map.tsx'
import { ArtifactsPane } from './Artifacts.tsx'
import { NotesPane } from './Notes.tsx'
import { TasksPane } from './Tasks.tsx'
import { DockEmpty } from './parts.tsx'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../kit/Empty.tsx'
import { pressTransform } from '../motion/press.ts'
import { DURATION, EASE, enterTransform } from '../motion/kit.tsx'
import { nextPresenceGeneration, presenceTransform } from '../motion/Presence.tsx'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { TerminalOnMenu } from '../machines/TerminalOnMenu.tsx'
import { leftSource } from '../drag/leave.ts'
import { beginTabDrag, isDraggingTab, consumeTabDrag, endTabPending, setTabContext, TabSlot, trackTabDrag } from './reorder.tsx'
import { chooseTab, closeTab, dockGeometry, finishDockDrag, moveDockDrag, setDock, startDockDrag, useDock, useDockDrag, type DockTab } from './store.ts'

/**
 * The dock's width (`App.tsx`: stiffness 420, damping 42, mass 0.7, an overdamped spring that is visually done in ~300 ms). The width
 * is a layout tween (every frame re-lays out the window), and the physical spring's tail takes ~850 ms to fall under half a pixel,
 * all of it per-frame relayout nobody can see (measured: 45 island renders over 450 ms against 19 for the old 220 ms tween). The
 * critically damped duration spring has the same shape and ends at 300 ms.
 */
const dockSlide = () => ({ type: 'spring' as const, duration: 0.3, bounce: 0 })
/** The spring ends at 300 ms; the guard that releases the content after a close waits a little longer. */
const DOCK_EXIT_GUARD_MS = 420
/**
 * The dock keeps navigational lists (ADE-54): what they list opens as a tab beside the chat. The viewers that used to be
 * panels here (terminal, browser, review) are reached from its + menu and the strip's own + menu.
 */
const VIEWERS: { id: string; label: string; icon: string; open: (threadId: string) => unknown }[] = [
  { id: 'terminal', label: 'New terminal', icon: DOCK_ICONS.terminal, open: async (threadId) => { const info = await threadClient(threadId)!.call('terminals.create', { thread_id: threadId, cols: 100, rows: 24 }); openTab(threadId, { kind: 'terminal', id: info.id }) } },
  { id: 'preview', label: 'Browser', icon: DOCK_ICONS.preview, open: (threadId) => openTab(threadId, { kind: 'preview' }) },
  { id: 'review', label: 'Review', icon: N.pullRequest, open: (threadId) => openTab(threadId, { kind: 'review' }) },
]
const PANELS: { id: DockTab; label: string; icon: string; width: number }[] = [
  { id: 'agents', label: 'Agents', icon: N.users, width: 100 },
  { id: 'project', label: 'Project', icon: N.note, width: 104 },
  { id: 'map', label: 'Map', icon: DOCK_ICONS.map, width: 90 },
  { id: 'activity', label: 'Activity', icon: DOCK_ICONS.activity, width: 104 },
  { id: 'changes', label: 'Changes', icon: DOCK_ICONS.changes, width: 104 },
  { id: 'artifacts', label: 'Artifacts', icon: DOCK_ICONS.artifacts, width: 110 },
  { id: 'explorer', label: 'Explorer', icon: DOCK_ICONS.explorer, width: 110 },
  { id: 'notes', label: 'Notes', icon: N.note, width: 96 },
  { id: 'tasks', label: 'Tasks', icon: N.tasks, width: 96 },
]

/** Panels that exist only on a project's Coordinator thread. */
const COORDINATOR_ONLY = new Set<DockTab | null>(['project', 'map'])

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
  return <DockShell key={threadId ?? 'home'} threadId={threadId} open={open} mounted={mounted} setMounted={setMounted} sidebarOpen={sidebarOpen} still={still} background={t.content} />
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
  // The content fades with the width: in over 250 ms, out over 150 ms (`generation` follows `open`, so a reversal retargets).
  const phase = useRef({ open, generation: nextPresenceGeneration(), mounted: 0 })
  if (phase.current.mounted === 0) phase.current.mounted = phase.current.generation
  if (phase.current.open !== open) phase.current = { ...phase.current, open, generation: nextPresenceGeneration() }
  const fade = still ? undefined : presenceTransform({ show: open, enter: { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: DURATION.fast, ease: [...EASE.smoothOut] } }, exit: { to: { opacity: 0 }, duration: DURATION.quick }, generation: phase.current.generation, fresh: phase.current.generation === phase.current.mounted })
  return <motion.div {...{ testId: 'right-dock' }} initial={still ? false : { width: 0 }} animate={{ width: open ? geometry.width : 0 }} transition={still ? { duration: 0 } : dockSlide()}
    onMotionComplete={() => setMounted(open)}
    style={{ display: 'flex', flexDirection: 'column', flexShrink: 0, height: '100%', minHeight: 0, overflow: 'hidden', position: geometry.overlay ? 'absolute' : 'relative', ...(geometry.overlay ? { top: 0, right: 0, bottom: 0, boxShadow: { offsetX: -8, offsetY: 0, blurRadius: 24, spreadRadius: 0, color: 'rgba(0, 0, 0, 0.16)' } } : {}), borderTopRightRadius: 12, borderBottomRightRadius: 12 }}>
    <div testId={geometry.overlay ? 'dock-overlay' : 'dock-inline'} paintTransform={fade} style={{ display: 'flex', flexDirection: 'column', width: geometry.width, height: '100%', flexShrink: 0, minHeight: 0, borderLeftWidth: 0.6, borderColor: t.borderLight, backgroundColor: geometry.overlay ? t.surface : background, borderTopRightRadius: 12, borderBottomRightRadius: 12 }}>
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
  const panels = PANELS.filter((panel) => !COORDINATOR_ONLY.has(panel.id) || coordinator)
  return (
    <Empty testId="dock-empty" style={{ padding: 24 }}>
      <EmptyHeader play={!instant}>
        <EmptyMedia variant="icon" icon={N.panelRight} />
        <EmptyTitle>No panels open</EmptyTitle>
        <EmptyDescription>Panels show a thread's activity, changes, files and more.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 6 }}>
        {panels.map((panel) => (
          <PickerChip key={panel.id} testId={`dock-empty-${panel.id}`} icon={panel.icon} chevron={false} label={`Open ${panel.label} panel`} onClick={() => chooseTab(threadId, panel.id)}>{panel.label}</PickerChip>
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
  const tab = COORDINATOR_ONLY.has(dock.tab) && !thread.coordinator_project_id ? dock.tabs.find((id) => !COORDINATOR_ONLY.has(id)) ?? null : dock.tab
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
        : tab === 'artifacts' ? <ArtifactsPane thread={thread} />
        : tab === 'notes' ? <NotesPane thread={thread} />
        : tab === 'tasks' ? <TasksPane thread={thread} />
        : tab === 'activity' ? <Activity {...tasks} />
        : tab === 'changes' ? <DiffPane thread={thread} onStats={onStats} />
        : tab === 'explorer' ? <Explorer key={thread.project_id} projectId={thread.project_id} thread={thread} width={width} />
        : tab === 'project' && thread.coordinator_project_id ? <ProjectPane thread={thread} />
        : tab === 'map' && thread.coordinator_project_id ? <MapPane thread={thread} /> : null}
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

/** The dock's strip: the kit `Tabs` (closable panels), reordered by drag (`reorder.tsx`), then + and collapse. */
function TabStrip({ threadId, width: _width, coordinator, activeTasks, stats }: { threadId: string | null; width: number; coordinator: boolean; activeTasks: number; stats: [number, number] }) {
  const t = useTheme()
  const dock = useDock(threadId)
  const keyboard = useNav((s) => s.keyboardNav)
  const { renderer } = useGpuix()
  const nodes = useRef(new Map<string, PublicInstance>())
  const strip = useRef<PublicInstance | null>(null)
  const panels = PANELS.filter((panel) => !COORDINATOR_ONLY.has(panel.id) || coordinator)
  const liveTabs = useMemo(() => dock.tabs.flatMap((id) => { const panel = panels.find((p) => p.id === id); return panel ? [panel] : [] }), [dock.tabs, coordinator])
  const tab = COORDINATOR_ONLY.has(dock.tab) && !coordinator ? liveTabs[0]?.id ?? null : dock.tab
  const widths = liveTabs.map((panel) => { const node = nodes.current.get(panel.id); return (node && renderer?.getElementBounds?.(node.id)?.width) || panel.width })
  setTabContext({ threadId, ids: liveTabs.map((p) => p.id), widths, icons: liveTabs.map((p) => p.icon), labels: liveTabs.map((p) => p.label), scroll: strip.current, row: strip.current })
  const select = (id: DockTab, instant = false) => { setDock(threadId, { instant }); chooseTab(threadId, id) }
  const items: TabsItem[] = liveTabs.map((panel) => ({
    key: panel.id,
    label: panel.label,
    icon: panel.icon,
    testId: `dock-tab-${panel.id}`,
    closeTestId: `dock-tab-close-${panel.id}`,
    ...(panel.id === 'activity' && activeTasks > 0 ? { extra: <Label key={activeTasks} color={t.textSecondary} size={10} paintAnimation={popAnimation()}>{String(activeTasks)}</Label> } : {}),
    ...(panel.id === 'changes' && stats[0] + stats[1] > 0 ? { extra: <div key={`${stats[0]}:${stats[1]}`} style={{ display: 'flex', gap: 3, flexShrink: 0 }}><Label color={t.green} size={10} paintAnimation={popAnimation()}>{`+${stats[0]}`}</Label><Label color={t.red} size={10} paintAnimation={popAnimation()}>{`−${stats[1]}`}</Label></div> } : {}),
  }))
  return <div {...ISLAND} testId="dock-tabs" style={{ display: 'flex', width: '100%', height: 46, alignItems: 'center', gap: 4, paddingLeft: 6, paddingRight: 6, flexShrink: 0, backgroundColor: t.content, borderTopRightRadius: 12, borderBottomWidth: 1, borderColor: t.surfaceDivider }}>
    <Tabs
      testId="dock-tab-strip"
      items={items}
      active={tab}
      gap={4}
      minWidth={0}
      animate={!keyboard && !dock.instant}
      underlineGap={8}
      onSelect={(id) => { if (!consumeTabDrag(id as DockTab)) select(id as DockTab) }}
      onClose={(id) => closeTab(threadId, id as DockTab)}
      onTabMouseDown={(id, e, rect) => beginTabDrag(id as DockTab, e, renderer, rect ? { ...rect, height: 28 } : null)}
      onTabMouseMove={(_id, e, left) => { if (!left) { trackTabDrag(e); return } if (!leftSource(e, renderer)) return; if (!isDraggingTab()) trackTabDrag(e, true); endTabPending() }}
      onTabMouseUp={() => endTabPending()}
      registerTab={(id, node) => { if (node) nodes.current.set(id, node); else nodes.current.delete(id) }}
      stripRef={(node) => { strip.current = node }}
      wrapTab={(id, node) => <TabSlot id={id as DockTab}>{node}</TabSlot>}
    />
    <Menu align="end" minWidth={196} testId="dock-add" trigger={() => <KitIconButton icon={N.plus} label="Add panel" />}>
      {panels.map((panel) => <MenuItem key={panel.id} id={panel.id} icon={panel.icon} label={panel.label} shortcut={dock.tabs.includes(panel.id) ? 'Open' : undefined} testId={`dock-add-${panel.id}`} onSelect={() => select(panel.id, keyboard)} />)}
      {threadId && <>
        <MenuSeparator />
        <MenuLabel>Open beside the chat</MenuLabel>
        {VIEWERS.map((viewer) => <Fragment key={viewer.id}><MenuItem id={`tab-${viewer.id}`} icon={viewer.icon} label={viewer.label} testId={`dock-open-${viewer.id}`} onSelect={() => void Promise.resolve().then(() => viewer.open(threadId)).catch((error) => toast.error(viewer.id === 'terminal' ? 'Unable to open a terminal' : `Unable to open ${viewer.label}`, { description: errorText(error) }))} />{viewer.id === 'terminal' && <TerminalOnMenu threadId={threadId} />}</Fragment>)}
      </>}
    </Menu>
    <Tip label="Collapse panel (⌘J)" side="top" size={28}><KitIconButton icon={N.panelRight} label="Collapse panel" onClick={() => setDock(threadId, { open: false, instant: false })} testId="dock-collapse" /></Tip>
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
