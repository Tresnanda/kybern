import { SidebarLeadingControls } from "@/views/chrome"
import { platform } from "@/lib/tauri"
// App shell: a window frame (title bar + app rail) on the window material, with
// one rounded workspace card on top of it: the offcanvas, resizable thread
// panel, the content surface, and the right dock.

import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { lazy, Suspense, useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import { ChatPaneDropOverlay } from "@/components/kybern/ChatPaneDropOverlay"
import { ErrorBoundary } from "@/components/kybern/ErrorBoundary"
import { DelayedSpinner, Logo, Spinner } from "@/components/kybern/bits"
import { Button } from "@/components/kit/button"
import { Sidebar, SidebarInset, SidebarProvider, sidebarOffcanvasMotionClass } from "@/components/kit/sidebar"
import { ResizeHandle } from "@/components/kybern/ResizeHandle"
import { useHotkey, useResize } from "@/lib/hooks"
import { CHAT_SURFACE_HEADER_HEIGHT_PX } from "@/lib/kit/desktopChrome"
import { cn } from "@/lib/utils"
import type { ThreadId } from "@/protocol"
import { newThread } from "@/state/nav"
import { useNavigationShortcuts } from "@/state/navigation"
import { boot, loadThread } from "@/state/rpc"
import { useEnvironments, activeEnvironment } from "@/state/environments"
import { useStore } from "@/state/store"
import { Draft } from "@/views/Draft"
import { HandoffDialog } from "@/views/Handoff"
import { NavRail } from "@/views/NavRail"
import { UsageView } from "@/views/UsagePage"
import { CloseGuard } from "@/views/CloseGuard"
import { SessionsDialog } from "@/views/SessionsDialog"
import { Palette } from "@/views/Palette"
import { PullRequests } from "@/views/PullRequests"
import { RightPanel } from "@/views/RightPanel"
import { SettingsScreen } from "@/views/SettingsScreen"
import { ThreadSidebar } from "@/views/Sidebar"
import { SplitThreads } from "@/views/SplitThreads"
import { ThreadView } from "@/views/Thread"
import { AppUpdateSurface } from "@/views/AppUpdate"
import { SurfaceHeader, TitlebarSlotProvider } from "@/views/chrome"
import { useNotesSync } from "@/views/notes/useNotesSync"
import { QuickNote } from "@/views/notes/QuickNote"
import { SaveToNotePicker } from "@/views/notes/SaveToNotePicker"
import { createAndOpenNote } from "@/state/notes"
import { openQuickNote } from "@/state/quickNote"
import { TasksSidebar } from "@/views/tasks/TasksSidebar"
import { useTasksSync } from "@/views/tasks/useTasksSync"
import { useUsageLimitsSync } from "@/views/useUsageLimitsSync"
import { newTaskHere } from "@/views/tasks/taskActions"

// The Notes page (editor and all) loads when it is first opened, not at launch.
const NotesView = lazy(() => import("@/views/notes/NotesPage").then((module) => ({ default: module.NotesView })))
// The Tasks page (list, board, drag and drop) loads the same way.
const TasksView = lazy(() => import("@/views/tasks/TasksPage").then((module) => ({ default: module.TasksView })))

/** Width of the app rail. */
const APP_RAIL_WIDTH = 52
/** With the panel collapsed, keep route titles clear of the window controls:
 *  they start at the traffic-light gutter (or 16px) and are 84px wide; the slot
 *  itself starts after the rail. */
const TITLEBAR_COLLAPSED_INSET_CLASS =
  platform() === "macos"
    ? "md:ps-[calc(var(--desktop-top-bar-traffic-light-gutter,82px)+84px-var(--app-rail-width))]"
    : "md:ps-[calc(16px+84px-var(--app-rail-width))]"
/** Pages without a panel have no sidebar controls, so their title starts right after the window controls. */
const TITLEBAR_PANELLESS_INSET_CLASS =
  platform() === "macos"
    ? "md:ps-[calc(var(--desktop-top-bar-traffic-light-gutter,82px)+12px-var(--app-rail-width))]"
    : "md:ps-[calc(16px+12px-var(--app-rail-width))]"

/** Gap between the workspace card and the window's right and bottom edges. */
const APP_FRAME_INSET = 8

const DOCK_MOTION = { type: "spring", stiffness: 420, damping: 42, mass: 0.7 } as const

/** Reserve readable chat width; use an overlay when both panes cannot fit. */
const RIGHT_DOCK_MIN_WIDTH = 26 * 16
const SIDEBAR_MIN_WIDTH = 208
function useDockWidth(containerRef: React.RefObject<HTMLDivElement | null>) {
  const [available, setAvailable] = useState(window.innerWidth)
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const observer = new ResizeObserver(([entry]) => setAvailable(entry.contentRect.width))
    observer.observe(container)
    return () => observer.disconnect()
  }, [containerRef])
  const overlay = available < RIGHT_DOCK_MIN_WIDTH + 320
  const max = Math.max(0, overlay ? available : available - 320)
  const resize = useResize({ initial: Math.max(RIGHT_DOCK_MIN_WIDTH, Math.round(window.innerWidth * 0.42)), min: RIGHT_DOCK_MIN_WIDTH, max, side: "right", storageKey: "kybern.dock.width" })
  return { ...resize, overlay, width: Math.min(resize.width, max) }
}

export default function App() {
  const epoch = useEnvironments((s) => s.epoch)
  return <><Workspace key={epoch} /><AppUpdateSurface /></>
}

function Workspace() {
  const connectionPending = useStore((s) => s.connection.state === "connecting")
  const resolutionFailed = useEnvironments((s) => s.error !== null)
  const connecting = connectionPending || resolutionFailed
  const selected = useStore((s) => s.selected)
  const splitView = useStore((s) => s.splitView)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  // Notes use the whole card: no panel there, while the sidebar preference waits for the next page.
  const panelless = selected.kind === "notes"
  const panelOpen = sidebarOpen && !panelless
  // Notes and Tasks are full pages with no dock. The preference is kept, so the dock returns on threads.
  const dockless = selected.kind === "notes" || selected.kind === "tasks"
  const rightOpen = useStore((s) => s.rightOpen) && !dockless
  const settingsOpen = useStore((s) => s.settingsOpen)
  const reducedMotion = useReducedMotion()
  const [keyboardNavigation, setKeyboardNavigation] = useState(false)
  const workspaceFocus = useRef<HTMLElement | null>(null)
  const set = useStore((s) => s.set)
  const [titlebarSlot, setTitlebarSlot] = useState<HTMLDivElement | null>(null)
  useNotesSync()
  useTasksSync()
  useUsageLimitsSync()

  useNavigationShortcuts()
  useHotkey("mod+b", () => set((s) => ({ sidebarOpen: !s.sidebarOpen })), { allowInInput: true, enabled: !settingsOpen && !panelless })
  useHotkey("mod+j", () => set((s) => ({ rightOpen: !s.rightOpen })), { allowInInput: true, enabled: !settingsOpen && !dockless })
  useHotkey("mod+k", () => set((s) => ({ paletteOpen: !s.paletteOpen })), { allowInInput: true })
  // On the Notes page ⌘N starts a note in the section you are in; everywhere else, a thread.
  useHotkey("mod+n", () => {
    set({ settingsOpen: false })
    if (useStore.getState().selected.kind === "notes") void createAndOpenNote()
    else if (useStore.getState().selected.kind === "tasks") newTaskHere()
    else newThread()
  }, { allowInInput: true })
  useHotkey("mod+shift+n", () => openQuickNote(), { allowInInput: true })
  useHotkey("mod+,", () => { setKeyboardNavigation(true); set({ settingsOpen: true }) }, { allowInInput: true })
  useHotkey("mod+\\", () => {
    if (useStore.getState().settingsOpen) return
    if (!useStore.getState().splitFocusedPane("horizontal")) toast("This pane can’t be split to the right")
  }, { allowInInput: true })
  useHotkey("mod+shift+\\", () => {
    if (useStore.getState().settingsOpen) return
    if (!useStore.getState().splitFocusedPane("vertical")) toast("This pane can’t be split below")
  }, { allowInInput: true })

  const threadId = selected.kind === "thread" ? selected.id : null
  const dockContainerRef = useRef<HTMLDivElement>(null)
  const dock = useDockWidth(dockContainerRef)
  const dockWidth = dock.width
  const sidebar = useResize({ initial: 256, min: SIDEBAR_MIN_WIDTH, max: 480, side: "left", storageKey: "kybern.sidebar.width" })
  // On a narrow window the panel gives way before the dock does: the content
  // column keeps room for the dock's minimum width, beside the rail and the
  // frame inset. The saved width returns when the window widens again.
  const workspaceRef = useRef<HTMLDivElement>(null)
  const [workspaceWidth, setWorkspaceWidth] = useState(() => window.innerWidth - APP_RAIL_WIDTH)
  useEffect(() => {
    const workspace = workspaceRef.current
    if (!workspace) return
    const observer = new ResizeObserver(([entry]) => setWorkspaceWidth(entry.contentRect.width))
    observer.observe(workspace)
    return () => observer.disconnect()
  }, [])
  const sidebarWidth = Math.max(SIDEBAR_MIN_WIDTH, Math.min(sidebar.width, workspaceWidth - APP_FRAME_INSET - RIGHT_DOCK_MIN_WIDTH))
  const dockRef = useRef<HTMLElement>(null)
  const overlayOpen = dock.overlay && rightOpen && !connecting
  useEffect(() => {
    if (!overlayOpen) return
    const panel = dockRef.current
    const previous = workspaceFocus.current
    panel?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus({ preventScroll: true })
    return () => {
      if (!useStore.getState().rightOpen && previous?.isConnected && (document.activeElement === document.body || panel?.contains(document.activeElement))) {
        requestAnimationFrame(() => { if (previous.isConnected && !previous.closest('[inert]')) previous.focus({ preventScroll: true }) })
      }
    }
  }, [overlayOpen])

  return (
    <SidebarProvider
      open={panelOpen}
      onOpenChange={(open) => {
        if (!panelless) set({ sidebarOpen: open })
      }}
      className="relative bg-(--app-frame-surface,var(--app-shell-background))"
      onPointerDownCapture={() => setKeyboardNavigation(false)}
      onKeyDownCapture={() => setKeyboardNavigation(true)}
      onFocusCapture={(event) => { if (!settingsOpen) workspaceFocus.current = event.target as HTMLElement }}
      data-sidebar-side="left"
      style={{ "--sidebar-width": `${sidebarWidth}px`, "--app-rail-width": `${APP_RAIL_WIDTH}px`, "--app-titlebar-height": `${CHAT_SURFACE_HEADER_HEIGHT_PX}px`, "--app-frame-inset": `${APP_FRAME_INSET}px` } as React.CSSProperties}
    >
      <TitlebarSlotProvider value={titlebarSlot}>
      {/* The rail stays live over Settings, which opens beside it. */}
      <NavRail />
      <div ref={workspaceRef} className="settings-workspace flex h-dvh min-w-0 flex-1" inert={settingsOpen} aria-hidden={settingsOpen || undefined} data-settings-open={settingsOpen} data-keyboard={keyboardNavigation || undefined}>
      {/* The title bar: one draggable strip across the frame, above the card. */}
      <div data-tauri-drag-region aria-hidden="true" className="drag-region fixed inset-x-0 top-0 z-[1] hidden h-(--app-titlebar-height) md:block" />
      <div className="fixed top-0 z-40 flex h-[46px] items-center" style={{ left: platform() === "macos" ? "var(--desktop-top-bar-traffic-light-gutter, 84px)" : "16px" }}>
        <SidebarLeadingControls className="hidden md:flex" />
      </div>
      {/* The panel is the card's leading section. It tucks away behind the rail:
          its shell clips at the rail's edge, so it never crosses the frame. */}
      <Sidebar
        side="left"
        collapsible="offcanvas"
        transparentSurface
        innerClassName="app-sidebar-panel"
        inert={!panelOpen}
        className="top-(--app-titlebar-height) bottom-(--app-frame-inset) left-(--app-rail-width) h-auto group-data-[collapsible=offcanvas]:pointer-events-none"
      >
        <ErrorBoundary label="the sidebar">
          {selected.kind === "tasks" ? <TasksSidebar /> : <ThreadSidebar />}
        </ErrorBoundary>
      </Sidebar>

      <div className="relative flex h-svh min-h-0 min-w-0 flex-1 md:pt-(--app-titlebar-height) md:pe-(--app-frame-inset) md:pb-(--app-frame-inset)">
        {/* Route headers render here, in the title bar over the content column.
            Collapsed, it starts after the window controls (padding, so the title
            travels with the panel's slide instead of popping). */}
        <div
          ref={setTitlebarSlot}
          data-titlebar-slot
          data-panel-open={panelOpen || undefined}
          data-tauri-drag-region="deep"
          className={cn(
            "app-titlebar-slot drag-region absolute top-0 left-0 right-(--app-frame-inset) z-[2] hidden h-(--app-titlebar-height) min-w-0 md:flex",
            "transition-[padding-inline-start] motion-reduce:transition-none",
            sidebarOffcanvasMotionClass(panelOpen),
            !panelOpen && (panelless ? TITLEBAR_PANELLESS_INSET_CLASS : TITLEBAR_COLLAPSED_INSET_CLASS),
          )}
        />
        {panelOpen && <ResizeHandle edge="left" label="Resize sidebar" onPointerDown={sidebar.onPointerDown} dragging={sidebar.dragging} className="z-[25]" />}
        {/* The content card owns the fill; an opaque inset behind it hides native vibrancy. */}
        <SidebarInset className="h-full min-h-0 overscroll-y-none text-foreground" surfaceClassName="bg-transparent">
          {/* Keep the full-window card out of its own stacking context. Its later DOM order already places it above the sidebar's z-0 shell; a z-index here forces WebKit to retain another viewport-sized backing. */}
          <div
            data-slot="sidebar-inset-surface"
            className="flex min-h-0 min-w-0 flex-1 flex-col text-inherit bg-[var(--color-background-surface)] chat-content-card workspace-card relative overflow-hidden"
          >
            <div ref={dockContainerRef} className="relative flex h-full min-h-0 min-w-0 flex-1 overflow-hidden">
              <main data-workspace-chat inert={overlayOpen} aria-hidden={overlayOpen || undefined} className="relative flex min-h-0 min-w-0 flex-1 flex-col">
                <ConnectionBanner />
                {connecting ? <Welcome /> : splitView ? (
                  <SplitThreads splitView={splitView} />
                ) : selected.kind === "thread" ? (
                  <SingleThreadSurface threadId={selected.id} />
                ) : selected.kind === "pulls" ? (
                  <ErrorBoundary label="pull requests">
                    <PullRequests />
                  </ErrorBoundary>
                ) : selected.kind === "usage" ? (
                  <ErrorBoundary label="usage">
                    <UsageView />
                  </ErrorBoundary>
                ) : selected.kind === "notes" ? (
                  <ErrorBoundary label="notes">
                    <Suspense fallback={null}>
                      <NotesView />
                    </Suspense>
                  </ErrorBoundary>
                ) : selected.kind === "tasks" ? (
                  <ErrorBoundary label="tasks">
                    <Suspense fallback={null}>
                      <TasksView />
                    </Suspense>
                  </ErrorBoundary>
                ) : selected.kind === "draft" ? (
                  <ErrorBoundary key={`${selected.draft.projectId ?? "free"}:${selected.draft.purpose ?? "thread"}`} label="the home screen">
                    <Draft key={`${selected.draft.projectId ?? "free"}:${selected.draft.purpose ?? "thread"}`} projectId={selected.draft.projectId} purpose={selected.draft.purpose} />
                  </ErrorBoundary>
                ) : (
                  <Welcome />
                )}
              </main>

              <AnimatePresence initial={false}>
                {rightOpen && !connecting && (
                  <motion.aside
                    ref={dockRef}
                    data-workspace-dock
                    data-overlay={dock.overlay || undefined}
                    key="dock"
                    initial={{ width: 0, opacity: 0 }}
                    animate={{ width: dockWidth, opacity: 1 }}
                    exit={{ width: 0, opacity: 0 }}
                    transition={dock.dragging ? { duration: 0 } : DOCK_MOTION}
                    className={cn("shrink-0 border-l border-[color:var(--app-surface-divider)]", dock.overlay ? "absolute inset-y-0 right-0 z-30 bg-[var(--color-background-surface)] shadow-xl" : "relative")}
                  >
                    <ResizeHandle edge="left" label="Resize right sidebar" onPointerDown={dock.onPointerDown} dragging={dock.dragging} />
                    <div className="h-full overflow-hidden" style={{ width: dockWidth }}>
                      <ErrorBoundary label="the panel">
                        <RightPanel threadId={threadId} />
                      </ErrorBoundary>
                    </div>
                  </motion.aside>
                )}
              </AnimatePresence>
            </div>
          </div>
        </SidebarInset>
      </div>

      </div>
      <AnimatePresence initial={false} onExitComplete={() => { if (!useStore.getState().settingsOpen && workspaceFocus.current?.isConnected) workspaceFocus.current.focus({ preventScroll: true }) }}>
        {settingsOpen && <motion.div key="settings-screen" className="absolute inset-y-0 right-0 left-0 z-50 md:left-(--app-rail-width)"
          style={{ willChange: "transform, opacity" }}
          initial={{ x: 8, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={reducedMotion || keyboardNavigation ? { opacity: 0 } : { x: 6, opacity: 0, transition: { duration: 0.12, ease: [0.4, 0, 1, 1] } }}
          transition={reducedMotion || keyboardNavigation ? { duration: 0 } : { type: "spring", duration: 0.3, bounce: 0 }}>
          <ErrorBoundary label="settings"><SettingsScreen sidebarResize={{ onPointerDown: sidebar.onPointerDown, dragging: sidebar.dragging }} /></ErrorBoundary>
        </motion.div>}
      </AnimatePresence>

      <ErrorBoundary label="the palette">
        <Palette />
      </ErrorBoundary>
      <ErrorBoundary label="quick note">
        <QuickNote />
        <SaveToNotePicker />
      </ErrorBoundary>
      <ErrorBoundary label="saved sessions">
        <SessionsDialog />
      </ErrorBoundary>
      <ErrorBoundary label="hand off">
        <HandoffDialog />
      </ErrorBoundary>
      <ErrorBoundary label="closing">
        <CloseGuard />
      </ErrorBoundary>
      </TitlebarSlotProvider>
    </SidebarProvider>
  )
}

function SingleThreadSurface({ threadId }: { threadId: ThreadId }) {
  return (
    <ChatPaneDropOverlay
      className="flex-col"
      excludedThreadIds={new Set([threadId])}
      onDropThread={({ threadId: droppedThreadId, direction, side }) => {
        const state = useStore.getState()
        if (state.splitFocusedPane(direction, droppedThreadId, side)) void loadThread(droppedThreadId)
      }}
    >
      <ErrorBoundary key={threadId} label="this thread">
        <ThreadView threadId={threadId} />
      </ErrorBoundary>
    </ChatPaneDropOverlay>
  )
}

function ConnectionBanner() {
  const reducedMotion = useReducedMotion()
  const connection = useStore((s) => s.connection)
  const name = activeEnvironment()?.name ?? "environment"
  const show = connection.state === "reconnecting" || connection.state === "failed"
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div
          key="conn"
          role="status"
          initial={{ y: reducedMotion ? 0 : -4, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: reducedMotion ? 0 : -4, opacity: 0 }}
          transition={{ duration: reducedMotion ? 0 : 0.15, ease: "easeOut" }}
          className={cn(
            "absolute top-14 inset-x-3 z-40 mx-auto flex w-fit max-w-[min(36rem,calc(100%-1.5rem))] items-center gap-3 px-3 py-2 text-[length:var(--app-font-size-ui-sm,13px)] leading-relaxed",
            "overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-xl",
          )}
        >
          {connection.state === "reconnecting" ? (
            <>
              <Spinner size={12} /><span className="min-w-0 break-words">Reconnecting to <bdi>{name}</bdi>…</span>
            </>
          ) : (
            <>
              <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-destructive" />
              <span className="min-w-0 break-words"><bdi>{name}</bdi>: {connection.detail}</span>
              <Button size="xs" variant="chrome-outline" onClick={() => void boot()}>
                Reconnect
              </Button>
            </>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function Welcome() {
  const connection = useStore((s) => s.connection)
  return (
    <div className="flex h-full flex-col">
      <SurfaceHeader minimal />
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center select-none">
        <Logo size={40} className="text-foreground/80" />
        {connection.state === "connecting" ? (
          <p className="flex items-center gap-2 text-[length:var(--app-font-size-ui,12px)] text-muted-foreground">
            <DelayedSpinner size={13} fallback={<span className="size-[13px] shrink-0" aria-hidden />} /> Connecting to {activeEnvironment()?.name ?? "environment"}
          </p>
        ) : connection.state !== "open" ? (
          <p className="text-sm text-muted-foreground">This environment is unavailable. Reconnect or choose another machine.</p>
        ) : (
          <>
            <h2 className="text-[26px] font-normal leading-[1.15] tracking-[-0.015em] text-foreground/95 sm:text-[30px]">Add a project to begin</h2>
            <p className="max-w-sm text-[length:var(--app-font-size-ui,12px)] text-muted-foreground/70 text-balance">
              kybern runs coding agents inside your repositories. Pick a folder and start a thread.
            </p>
          </>
        )}
      </div>
    </div>
  )
}
