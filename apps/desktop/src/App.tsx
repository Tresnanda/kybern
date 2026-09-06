import { SidebarLeadingControls } from "@/views/chrome"
import { platform } from "@/lib/tauri"
// App shell: an offcanvas, resizable,
// translucent left sidebar; a content card with a seam rail; the right dock.

import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { useEffect, useState } from "react"
import { toast } from "sonner"

import { ChatPaneDropOverlay } from "@/components/kybern/ChatPaneDropOverlay"
import { ErrorBoundary } from "@/components/kybern/ErrorBoundary"
import { Logo, Spinner } from "@/components/kybern/bits"
import { Button } from "@/components/kit/button"
import { Sidebar, SidebarInset, SidebarProvider } from "@/components/kit/sidebar"
import { Toaster } from "@/components/ui/sonner"
import { ResizeHandle } from "@/components/kybern/ResizeHandle"
import { useHotkey, useResize } from "@/lib/hooks"
import { cn } from "@/lib/utils"
import type { ThreadId } from "@/protocol"
import { newThread } from "@/state/nav"
import { boot, loadThread } from "@/state/rpc"
import { useEnvironments, activeEnvironment } from "@/state/environments"
import { useStore } from "@/state/store"
import { Draft } from "@/views/Draft"
import { HandoffDialog } from "@/views/Handoff"
import { CloseGuard } from "@/views/CloseGuard"
import { Palette } from "@/views/Palette"
import { PullRequests } from "@/views/PullRequests"
import { RightPanel } from "@/views/RightPanel"
import { SettingsDialog } from "@/views/SettingsDialog"
import { ThreadSidebar } from "@/views/Sidebar"
import { SplitThreads } from "@/views/SplitThreads"
import { ThreadView } from "@/views/Thread"
import { SurfaceHeader } from "@/views/chrome"

const DOCK_MOTION = { type: "spring", stiffness: 420, damping: 42, mass: 0.7 } as const

/** The dock opens at half the shell, never narrower than 26rem; the seam is draggable. */
const RIGHT_DOCK_MIN_WIDTH = 26 * 16
function useDockWidth() {
  const [max, setMax] = useState(() => Math.max(RIGHT_DOCK_MIN_WIDTH, Math.round(window.innerWidth * 0.7)))
  useEffect(() => {
    const onResize = () => setMax(Math.max(RIGHT_DOCK_MIN_WIDTH, Math.round(window.innerWidth * 0.7)))
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [])
  const resize = useResize({ initial: Math.max(RIGHT_DOCK_MIN_WIDTH, Math.round(window.innerWidth * 0.42)), min: RIGHT_DOCK_MIN_WIDTH, max, side: "right", storageKey: "kybern.dock.width" })
  return { ...resize, width: Math.min(resize.width, max) }
}

export default function App() {
  const epoch = useEnvironments((s) => s.epoch)
  return <Workspace key={epoch} />
}

function Workspace() {
  const connectionPending = useStore((s) => s.connection.state === "connecting")
  const resolutionFailed = useEnvironments((s) => s.error !== null)
  const connecting = connectionPending || resolutionFailed
  const selected = useStore((s) => s.selected)
  const splitView = useStore((s) => s.splitView)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const rightOpen = useStore((s) => s.rightOpen)
  const set = useStore((s) => s.set)

  useHotkey("mod+b", () => set((s) => ({ sidebarOpen: !s.sidebarOpen })), { allowInInput: true })
  useHotkey("mod+j", () => set((s) => ({ rightOpen: !s.rightOpen })), { allowInInput: true })
  useHotkey("mod+k", () => set((s) => ({ paletteOpen: !s.paletteOpen })), { allowInInput: true })
  useHotkey("mod+n", () => newThread(), { allowInInput: true })
  useHotkey("mod+,", () => set({ settingsOpen: true }), { allowInInput: true })
  useHotkey("mod+\\", () => {
    if (!useStore.getState().splitFocusedPane("horizontal")) toast("This pane can’t be split to the right")
  }, { allowInInput: true })
  useHotkey("mod+shift+\\", () => {
    if (!useStore.getState().splitFocusedPane("vertical")) toast("This pane can’t be split below")
  }, { allowInInput: true })

  const threadId = selected.kind === "thread" ? selected.id : null
  const dock = useDockWidth()
  const dockWidth = dock.width
  const sidebar = useResize({ initial: 256, min: 208, max: 480, side: "left", storageKey: "kybern.sidebar.width" })

  return (
    <SidebarProvider
      open={sidebarOpen}
      onOpenChange={(open) => set({ sidebarOpen: open })}
      className="bg-[var(--app-shell-background)]"
      data-sidebar-side="left"
      style={{ "--sidebar-width": `${sidebar.width}px` } as React.CSSProperties}
    >
      <div className="fixed top-0 z-40 flex h-[46px] items-center" style={{ left: platform() === "macos" ? "var(--desktop-top-bar-traffic-light-gutter, 84px)" : "16px" }}>
        <SidebarLeadingControls className="hidden md:flex" />
      </div>
      <Sidebar
        side="left"
        collapsible="offcanvas"
        transparentSurface
        innerClassName="app-sidebar-surface"
      >
        <ErrorBoundary label="the sidebar">
          <ThreadSidebar />
        </ErrorBoundary>
      </Sidebar>

      <div className="relative flex h-svh min-h-0 min-w-0 flex-1">
        {sidebarOpen && <ResizeHandle edge="left" label="Resize sidebar" onPointerDown={sidebar.onPointerDown} dragging={sidebar.dragging} className="z-[25]" />}
        {/* The content card owns the fill; an opaque inset behind it hides native vibrancy. */}
        <SidebarInset className="h-dvh min-h-0 overscroll-y-none text-foreground" surfaceClassName="bg-transparent">
          <div
            data-slot="sidebar-inset-surface"
            className="flex min-h-0 min-w-0 flex-1 flex-col text-inherit bg-[var(--color-background-surface)] chat-content-card relative z-[15] overflow-hidden"
          >
            <div className="flex h-dvh min-h-0 min-w-0 flex-1 overflow-hidden">
              <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">
                <ConnectionBanner />
                {connecting ? <Welcome /> : splitView ? (
                  <SplitThreads splitView={splitView} />
                ) : selected.kind === "thread" ? (
                  <SingleThreadSurface threadId={selected.id} />
                ) : selected.kind === "pulls" ? (
                  <ErrorBoundary label="pull requests">
                    <PullRequests />
                  </ErrorBoundary>
                ) : selected.kind === "draft" ? (
                  <ErrorBoundary key={selected.draft.projectId} label="the home screen">
                    <Draft key={selected.draft.projectId} projectId={selected.draft.projectId} />
                  </ErrorBoundary>
                ) : (
                  <Welcome />
                )}
              </main>

              <AnimatePresence initial={false}>
                {rightOpen && !connecting && (
                  <motion.aside
                    key="dock"
                    initial={{ width: 0, opacity: 0 }}
                    animate={{ width: dockWidth, opacity: 1 }}
                    exit={{ width: 0, opacity: 0 }}
                    transition={dock.dragging ? { duration: 0 } : DOCK_MOTION}
                    className="relative shrink-0 border-l border-[color:var(--app-surface-divider)]"
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

      <ErrorBoundary label="the palette">
        <Palette />
      </ErrorBoundary>
      <ErrorBoundary label="settings">
        <SettingsDialog />
      </ErrorBoundary>
      <ErrorBoundary label="hand off">
        <HandoffDialog />
      </ErrorBoundary>
      <ErrorBoundary label="closing">
        <CloseGuard />
      </ErrorBoundary>
      <Toaster position="bottom-right" />
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
            <Spinner size={13} /> Connecting to {activeEnvironment()?.name ?? "environment"}
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
