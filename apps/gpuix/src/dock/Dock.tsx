// Native right dock. Only the chosen pane is mounted; the shell keeps it through
// the 220 ms exit, just like App's thread panel. Each painted edge owns its radii.
import { popAnimation } from '../kit/Pop.tsx'
import { motion, useGpuix, type PublicInstance } from '@gpuix/react'
import { useSidebarWidth, useWindowWidth } from '../shell/layout.ts'
import { useCallback, useEffect, useRef, useState } from 'react'
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
import { beginTabDrag, isDraggingTab, consumeTabDrag, endTabPending, setTabContext, TabSlot, trackTabDrag } from './reorder.tsx'
import { chooseTab, closeTab, dockGeometry, finishDockDrag, moveDockDrag, setDock, startDockDrag, useDock, useDockDrag, type DockTab } from './store.ts'

const SLIDE = { duration: 0.22, ease: EASE_OUT }
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
    const timer = setTimeout(() => setMounted(false), 260)
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
  return <motion.div {...{ testId: 'right-dock' }} initial={still ? false : { width: 0 }} animate={{ width: open ? geometry.width : 0 }} transition={still ? { duration: 0 } : SLIDE}
    onMotionComplete={() => setMounted(open)}
    style={{ display: 'flex', flexDirection: 'column', flexShrink: 0, height: '100%', minHeight: 0, overflow: 'hidden', position: geometry.overlay ? 'absolute' : 'relative', ...(geometry.overlay ? { top: 0, right: 0, bottom: 0, boxShadow: { offsetX: -8, offsetY: 0, blurRadius: 24, spreadRadius: 0, color: 'rgba(0, 0, 0, 0.16)' } } : {}), borderTopRightRadius: 12, borderBottomRightRadius: 12 }}>
    <div testId={geometry.overlay ? 'dock-overlay' : 'dock-inline'} style={{ display: 'flex', flexDirection: 'column', width: geometry.width, height: '100%', flexShrink: 0, minHeight: 0, borderLeftWidth: 0.6, borderColor: t.borderLight, backgroundColor: background, borderTopRightRadius: 12, borderBottomRightRadius: 12 }}>
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

function ThreadDock({ thread, width }: { thread: Thread; width: number }) {
  const t = useTheme()
  const dock = useDock(thread.id)
  const tasks = useRuntimeTasks(thread.id)
  const [stats, setStats] = useState<[number, number]>([0, 0])
  const onStats = useCallback((adds: number, dels: number) => setStats((previous) => previous[0] === adds && previous[1] === dels ? previous : [adds, dels]), [])
  const tab = dock.tab === 'project' && !thread.coordinator_project_id ? dock.tabs.find((id) => id !== 'project') ?? null : dock.tab
  return <>
    <TabStrip threadId={thread.id} width={width} coordinator={!!thread.coordinator_project_id} activeTasks={tasks.tasks.filter(isActiveTask).length} stats={stats} />
    <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0, minWidth: 0, overflow: 'hidden', borderBottomRightRadius: 12 }}>
      {tab === null ? <div style={{ display: 'flex', flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}><Label color={t.textSecondary} size={12}>Add a panel with +.</Label></div>
        : tab === 'agents' ? <Agents thread={thread} />
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
    </div>
  </>
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
  const tabs = dock.tabs.flatMap((id) => { const panel = panels.find((p) => p.id === id); return panel ? [panel] : [] })
  const tab = dock.tab === 'project' && !coordinator ? tabs[0]?.id ?? null : dock.tab
  const widths = tabs.map((panel) => panel.width + (panel.id === 'activity' && activeTasks ? 18 : panel.id === 'changes' && stats[0] + stats[1] ? 65 : 0))
  const index = tabs.findIndex((p) => p.id === tab)
  const left = widths.slice(0, Math.max(0, index)).reduce((n, value) => n + value + 4, 0)
  const selectedWidth = widths[index] ?? 0
  setTabContext({ threadId, ids: tabs.map((p) => p.id), widths, icons: tabs.map((p) => p.icon), labels: tabs.map((p) => p.label), scroll: scroll.current, row: rowRef.current })
  const select = (id: DockTab, instant = false) => { setDock(threadId, { instant }); chooseTab(threadId, id) }
  useEffect(() => {
    // One post-commit scroll so a newly added chip is brought into view.
    const timer = setTimeout(() => { if (scroll.current) renderer?.scrollTo?.(scroll.current.id, -Math.max(0, left + selectedWidth - (width - 78)), 0) }, 16)
    return () => clearTimeout(timer)
  }, [left, selectedWidth, width, renderer])
  return <div {...ISLAND} testId="dock-tabs" style={{ display: 'flex', width: '100%', height: 46, alignItems: 'center', gap: 4, paddingLeft: 6, paddingRight: 6, flexShrink: 0, backgroundColor: t.surface, borderTopRightRadius: 12 }}>
    <div ref={scroll} style={{ display: 'flex', alignItems: 'center', flexGrow: 1, minWidth: 0, height: 32, overflowX: 'scroll', overflowY: 'hidden' }}>
      <div ref={rowRef} style={{ display: 'flex', alignItems: 'center', position: 'relative', gap: 4, height: 28, flexShrink: 0 }}>
        {tab && <motion.div initial={false} animate={{ left, width: selectedWidth }} transition={REDUCED_MOTION || keyboard || dock.instant ? { duration: 0 } : SLIDE}
          style={{ position: 'absolute', top: 0, height: 28, borderRadius: 8, backgroundColor: t.buttonSecondary, pointerEvents: 'none' }} />}
        {tabs.map((panel, i) => <TabSlot key={panel.id} id={panel.id}><div style={{ display: 'flex', alignItems: 'center', height: 28, width: widths[i], flexShrink: 0, borderRadius: 8, hover: { backgroundColor: t.buttonSecondaryHover } }}>
          <div ref={(node) => { if (node) tabRefs.current.set(panel.id, node); else tabRefs.current.delete(panel.id) }} testId={`dock-tab-${panel.id}`} role="tab" aria-selected={panel.id === tab} tabIndex={panel.id === tab ? 0 : -1} onClick={() => { if (!consumeTabDrag(panel.id)) select(panel.id) }}
            onMouseDown={(e) => { const node = tabRefs.current.get(panel.id); beginTabDrag(panel.id, e, renderer, node && renderer?.getElementBounds?.(node.id) ? { ...renderer.getElementBounds(node.id)!, width: widths[i]!, height: 28 } : null) }}
            onMouseMove={trackTabDrag} onMouseUp={endTabPending} onMouseLeave={(e) => { if (!isDraggingTab()) trackTabDrag(e, true); endTabPending() }}
            onKeyDown={(event) => {
              if (event.key === 'left' || event.key === 'right') {
                const next = tabs[(i + (event.key === 'left' ? tabs.length - 1 : 1)) % tabs.length]!.id
                select(next, true)
                const node = tabRefs.current.get(next)
                if (node) renderer?.focusElement?.(node.id)
              }
              if (event.key === 'enter' || event.key === 'space') select(panel.id, true)
            }}
            style={{ display: 'flex', alignItems: 'center', gap: 6, flexGrow: 1, minWidth: 0, height: 28, paddingLeft: 6, cursor: 'pointer', borderRadius: 8 }}>
            <Icon source={panel.icon} size={14} color={t.textSecondary} />
            <Label color={panel.id === tab ? t.text : t.textSecondary} size={13}>{panel.label}</Label>
            {panel.id === 'activity' && activeTasks > 0 && <Label key={activeTasks} color={t.textSecondary} size={10} paintAnimation={popAnimation()}>{String(activeTasks)}</Label>}
            {panel.id === 'changes' && stats[0] + stats[1] > 0 && <div key={`${stats[0]}:${stats[1]}`} style={{ display: 'flex', gap: 3 }}><Label color={t.green} size={10} paintAnimation={popAnimation()}>{`+${stats[0]}`}</Label><Label color={t.red} size={10} paintAnimation={popAnimation()}>{`−${stats[1]}`}</Label></div>}
          </div>
          <IconButton icon={N.x} glyph={12} size={24} label={`Close ${panel.label} panel`} onClick={() => closeTab(threadId, panel.id)} testId={`dock-tab-close-${panel.id}`} />
        </div></TabSlot>)}
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
