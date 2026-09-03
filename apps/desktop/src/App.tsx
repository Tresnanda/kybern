// App shell, mirroring Synara's `_chat.tsx` route: an offcanvas, resizable,
// translucent left sidebar; a content card with a seam rail; the right dock.

import { AnimatePresence, motion } from "motion/react"
import { useEffect, useState } from "react"

import { ErrorBoundary } from "@/components/kybern/ErrorBoundary"
import { Logo, Spinner } from "@/components/kybern/bits"
import { Button } from "@/components/synara/button"
import { Sidebar, SidebarInset, SidebarProvider } from "@/components/synara/sidebar"
import { Toaster } from "@/components/ui/sonner"
import { ResizeHandle } from "@/components/kybern/ResizeHandle"
import { useHotkey, useResize } from "@/lib/hooks"
import { cn } from "@/lib/utils"
import { newThread } from "@/state/nav"
import { boot } from "@/state/rpc"
import { useStore } from "@/state/store"
import { Draft } from "@/views/Draft"
import { HandoffDialog } from "@/views/Handoff"
import { Palette } from "@/views/Palette"
import { PullRequests } from "@/views/PullRequests"
import { RightPanel } from "@/views/RightPanel"
import { SettingsDialog } from "@/views/SettingsDialog"
import { ThreadSidebar } from "@/views/Sidebar"
import { ThreadView } from "@/views/Thread"
import { SurfaceHeader } from "@/views/chrome"

const DOCK_MOTION = { type: "spring", stiffness: 420, damping: 42, mass: 0.7 } as const

/** Synara opens the dock at half the shell, never narrower than 26rem; the seam is draggable. */
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
  const selected = useStore((s) => s.selected)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const rightOpen = useStore((s) => s.rightOpen)
  const set = useStore((s) => s.set)

  useHotkey("mod+b", () => set((s) => ({ sidebarOpen: !s.sidebarOpen })), { allowInInput: true })
  useHotkey("mod+j", () => set((s) => ({ rightOpen: !s.rightOpen })), { allowInInput: true })
  useHotkey("mod+k", () => set((s) => ({ paletteOpen: !s.paletteOpen })), { allowInInput: true })
  useHotkey("mod+n", () => newThread(), { allowInInput: true })
  useHotkey("mod+,", () => set({ settingsOpen: true }), { allowInInput: true })

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
      <Sidebar side="left" collapsible="offcanvas" transparentSurface>
        <ErrorBoundary label="the sidebar">
          <ThreadSidebar />
        </ErrorBoundary>
      </Sidebar>

      <div className="relative flex h-svh min-h-0 min-w-0 flex-1">
        {sidebarOpen && <ResizeHandle edge="left" label="Resize sidebar" onPointerDown={sidebar.onPointerDown} dragging={sidebar.dragging} className="z-[25]" />}
        <SidebarInset className="h-dvh min-h-0 overscroll-y-none text-foreground">
          <div
            data-slot="sidebar-inset-surface"
            className="flex min-h-0 min-w-0 flex-1 flex-col text-inherit bg-[var(--color-background-surface)] chat-content-card relative z-[15] overflow-hidden"
          >
            <div className="flex h-dvh min-h-0 min-w-0 flex-1 overflow-hidden">
              <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">
                <ConnectionBanner />
                {selected.kind === "thread" ? (
                  <ErrorBoundary key={selected.id} label="this thread">
                    <ThreadView threadId={selected.id} />
                  </ErrorBoundary>
                ) : selected.kind === "pulls" ? (
                  <ErrorBoundary label="pull requests">
                    <PullRequests />
                  </ErrorBoundary>
                ) : selected.kind === "draft" ? (
                  <ErrorBoundary key={selected.draft.projectId} label="the home screen">
                    <Draft projectId={selected.draft.projectId} />
                  </ErrorBoundary>
                ) : (
                  <Welcome />
                )}
              </main>

              <AnimatePresence initial={false}>
                {rightOpen && (
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
      <Toaster position="bottom-right" />
    </SidebarProvider>
  )
}

function ConnectionBanner() {
  const connection = useStore((s) => s.connection)
  const show = connection.state === "reconnecting" || connection.state === "failed"
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          key="conn"
          initial={{ y: -8, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -8, opacity: 0 }}
          transition={DOCK_MOTION}
          className={cn(
            "absolute top-14 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 px-3 py-1.5 text-[length:var(--app-font-size-ui-sm,11px)]",
            "overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-xl",
          )}
        >
          {connection.state === "reconnecting" ? (
            <>
              <Spinner size={12} /> Reconnecting to the daemon
            </>
          ) : (
            <>
              <span className="size-1.5 rounded-full bg-destructive" />
              <span>Lost the daemon. {connection.detail}</span>
              <Button size="xs" variant="chrome-outline" onClick={() => void boot()}>
                Retry
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
            <Spinner size={13} /> Starting the daemon
          </p>
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
