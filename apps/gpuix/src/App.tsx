import { CloseGuard } from './shell/CloseGuard.tsx'
import { WorkspaceDialogs } from './dialogs/Dialogs.tsx'
import { EnvironmentMenu } from './sidebar/EnvironmentSwitcher.tsx'
import { EnvironmentDialogs } from './environments/Dialogs.tsx'
import { useEnvironment } from './shell/environment.ts'
// The window shell (`App.tsx`, `views/chrome.tsx`): a 46px title bar and a 52px
// rail painted on the frame surface, and one 12px-radius card holding the thread
// panel and the page. All geometry follows the desktop. The title bar, rail,
// palette and dialogs live in `nav/`; the thread panel in `Sidebar.tsx`.
import { EnvironmentOverlay } from './environment/Panel.tsx'
import { FILL_ISLAND, ISLAND } from './MatrixLoader.tsx'
import { motion } from '@gpuix/react'
import { useEffect, useState, type ReactNode } from 'react'
import { NotesPage } from './notes/NotesPage.tsx'
import { SettingsScreen } from './settings/SettingsScreen.tsx'
import { UsagePage } from './usage/UsagePage.tsx'
import { PullRequestsPage } from './pulls/PullRequestsPage.tsx'
import { TasksDragLayer } from './tasks/drag.tsx'
import { TasksPage } from './tasks/TasksPage.tsx'
import { TasksSidebar } from './tasks/TasksSidebar.tsx'
import { useTasksFeed } from './tasks/store.ts'
import { NativeSubagentComposer } from './subagents/Composer.tsx'
import { SubagentBar, SubagentPageMotion } from './subagents/Page.tsx'
import { Composer } from './Composer.tsx'
import { PreviewIntegration } from './preview/Preview.tsx'
import { ComputerLiveView } from './live/ComputerLiveView.tsx'
import { Dock, DockResizeCapture } from './dock/Dock.tsx'
import { Draft } from './Draft.tsx'
import { Icon } from './icons.tsx'
import { N } from './nav/glyphs.ts'
import { HandoffDialog } from './nav/Handoff.tsx'
import { startNavHistory } from './nav/history.ts'
import { startLive } from './nav/live.ts'
import { NavRail } from './nav/NavRail.tsx'
import { Palette } from './nav/Palette.tsx'
import { SessionsDialog } from './nav/Sessions.tsx'
import { getNav, pointerNav, useNav, type Page } from './nav/store.ts'
import { Rise } from './motion/kit.tsx'
import { TitleBar, usePanelOpen } from './nav/TitleBar.tsx'
import { Sidebar } from './Sidebar.tsx'
import { startAgentToasts } from './shell/agentToasts.ts'
import { ConnectionBanner, useWelcome, Welcome } from './shell/Connection.tsx'
import { ErrorBoundary } from './shell/ErrorBoundary.tsx'
import { useSidebarDragging, useSidebarWidth } from './shell/layout.ts'
import { SidebarDragLayer, SidebarResizeHandle } from './shell/ResizeHandle.tsx'
import { Toaster } from './shell/toasts.tsx'
import { useApp } from './state.ts'
import { COLUMN, GUTTER, Transcript } from './Transcript.tsx'
import { ThreadRequests, useBlockingRequest } from './transcript/Requests.tsx'
import { EASE_OUT, Label, REDUCED_MOTION, useTheme } from './ui.tsx'

const INSET = 8
const CARD_RADIUS = 12

// Sliding pieces move on the strong ease-out: quick to respond, soft to land.
// Reduce Motion, and toggles from the keyboard, change without movement.
const SLIDE = { duration: 0.22, ease: EASE_OUT }

export function App() {
  const env = useEnvironment()
  return <Workspace key={`${env.id}:${env.revision}`} />
}

function Workspace() {
  useTasksFeed()
  const t = useTheme()
  const page = useNav((s) => s.page)
  const settingsOpen = useNav((s) => s.settingsOpen)
  const instant = useNav((s) => s.panelInstant || s.keyboardNav)
  const panelOpen = usePanelOpen() && !settingsOpen
  const sidebarWidth = useSidebarWidth()
  const resizing = useSidebarDragging()
  const welcome = useWelcome()
  // The slide plays only when the panel opens or closes; a drag or a window resize moves it at once.
  const [seenOpen, setSeenOpen] = useState(panelOpen)
  const [sliding, setSliding] = useState(false)
  if (seenOpen !== panelOpen) {
    setSeenOpen(panelOpen)
    setSliding(true)
  }
  // Keep the panel's rows mounted only while it shows or animates: hidden
  // elements still cost layout on every frame in GPUI.
  const [panelMounted, setPanelMounted] = useState(panelOpen)
  if (panelOpen && !panelMounted) setPanelMounted(true)
  const still = REDUCED_MOTION || instant
  if (still && !panelOpen && panelMounted) setPanelMounted(false)
  const edge = t.variant === 'dark' ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.10)'

  useEffect(() => {
    startLive()
    startAgentToasts()
    startNavHistory()
  }, [])

  return (
    <div
      testId="app-ready"
      // Any press makes later navigation pointer-driven again (`keyboardNav`).
      onMouseDown={pointerNav}
      style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', backgroundColor: t.frame, position: 'relative' }}
    >
      <TitleBar panelOpen={panelOpen} />
      <div style={{ display: 'flex', flexGrow: 1, minHeight: 0, paddingRight: INSET, paddingBottom: INSET }}>
        <NavRail />
        {/* GPUI clips overflow to a rectangle, so each surface rounds its own
            corners like the desktop: the panel takes the leading pair, the content
            the trailing pair (all four once the panel is gone, `kit.css:172-198`).
            Strokes are 0.6px: the panel's top/leading/bottom, the content's ring. */}
        <div style={{ display: 'flex', flexGrow: 1, minWidth: 0 }}>
          <motion.div
            initial={false}
            animate={{ width: panelOpen ? sidebarWidth : 0 }}
            transition={still || resizing || !sliding ? { duration: 0 } : SLIDE}
            onMotionComplete={() => {
              setPanelMounted(panelOpen)
              setSliding(false)
            }}
            style={{ display: 'flex', height: '100%', flexShrink: 0, overflow: 'hidden' }}
          >
            {/* Cached islands (native/README.md): the panel, the content card, the title
                bar and the rail each replay while another of them animates. */}
            <div
              {...ISLAND}
              style={{
                display: 'flex',
                width: sidebarWidth,
                height: '100%',
                flexShrink: 0,
                backgroundColor: t.sidebar,
                borderTopLeftRadius: CARD_RADIUS,
                borderBottomLeftRadius: CARD_RADIUS,
                borderTopWidth: 0.6,
                borderLeftWidth: 0.6,
                borderBottomWidth: 0.6,
                borderColor: edge,
              }}
            >
              {panelMounted && (
                <ErrorBoundary label="the sidebar" compact>
                  {page === 'tasks' ? <TasksSidebar /> : <Sidebar />}
                </ErrorBoundary>
              )}
            </div>
          </motion.div>
          <div
            {...FILL_ISLAND}
            style={{
              display: 'flex',
              flexDirection: 'column',
              flexGrow: 1,
              minWidth: 0,
              backgroundColor: t.surface,
              borderWidth: 0.6,
              borderColor: edge,
              borderTopRightRadius: CARD_RADIUS,
              borderBottomRightRadius: CARD_RADIUS,
              borderTopLeftRadius: panelMounted ? 0 : CARD_RADIUS,
              borderBottomLeftRadius: panelMounted ? 0 : CARD_RADIUS,
            }}
          >
            <div style={{ display: 'flex', flexGrow: 1, minHeight: 0, minWidth: 0, position: 'relative' }}>
            <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0, minHeight: 0 }}>
            <PageEnter page={settingsOpen ? 'settings' : page}>
              <ErrorBoundary label="this page" key={settingsOpen ? 'settings' : page}>
                {settingsOpen ? <SettingsScreen /> : welcome ? <Welcome kind={welcome} /> : <PageView page={page} />}
              </ErrorBoundary>
            </PageEnter>
            <ConnectionBanner />
            </div>
            {/* Settings covers the workspace, dock included, as on the desktop. */}
            {!settingsOpen && <Dock sidebarOpen={panelOpen} />}
            {!settingsOpen && page === 'home' && <ComputerLiveView />}
            <PreviewIntegration />
            </div>
          </div>
          {panelOpen && <SidebarResizeHandle />}
        </div>
      </div>
      <Palette />
      <HandoffDialog />
      <SessionsDialog />
      <EnvironmentOverlay />
      <EnvironmentDialogs />
      <EnvironmentMenu />
      <WorkspaceDialogs />
      <CloseGuard />
      <Toaster />
      <SidebarDragLayer />
      <DockResizeCapture />
      <TasksDragLayer />
    </div>
  )
}

/**
 * A page switch from the rail or a menu rises in like `t-section-enter` (6px,
 * 250 ms smooth-out). The first page, and switches from a shortcut, appear at once.
 */
function PageEnter({ page, children }: { page: string; children: ReactNode }) {
  const [shown, setShown] = useState({ page, play: false })
  if (shown.page !== page) setShown({ page, play: !getNav().keyboardNav })
  return (
    <Rise key={shown.page} kind="section" play={shown.play && shown.page === page} style={{ flexGrow: 1, minHeight: 0 }}>
      {children}
    </Rise>
  )
}

/** The rail destination's page. */
function PageView({ page }: { page: Page }) {
  switch (page) {
    case 'home':
      return <HomePage />
    case 'notes': return <NotesPage />
    case 'tasks': return <TasksPage />
    case 'usage':
      return <UsagePage />
    case 'pulls':
      return <PullRequestsPage />
    default:
      return <ElsewherePage page={page} />
  }
}

function HomePage() {
  const thread = useApp((s) => s.open.thread)
  const selectedId = useApp((s) => s.selectedId)
  const blocking = useBlockingRequest()
  if (!selectedId) return <Draft />
  return (
    <SubagentPageMotion>
      <ErrorBoundary label="the transcript">
        <Transcript />
      </ErrorBoundary>
      <BottomFade />
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, display: 'flex', justifyContent: 'center', paddingLeft: GUTTER, paddingRight: GUTTER, paddingBottom: 16 }}>
        {/* Pending approvals and questions stack on the composer; a blocking one replaces it. */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%', maxWidth: COLUMN }}>
          {!thread?.subagent && <ThreadRequests />}
          {!blocking && (
            <ErrorBoundary label="the composer" compact>
              {thread?.subagent ? thread.provider.kind === 'claude-code' ? <NativeSubagentComposer key={thread.id} thread={thread} /> : <SubagentBar thread={thread} /> : <Composer thread={thread} />}
            </ErrorBoundary>
          )}
        </div>
      </div>
    </SubagentPageMotion>
  )
}

/** Transcript bottom fade: min(12%, 40px), transparent → surface. */
function BottomFade() {
  const t = useTheme()
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        height: 40,
        pointerEvents: 'none',
        // Paints over the card's bottom edge, so it carries the card's corners.
        borderBottomLeftRadius: CARD_RADIUS,
        borderBottomRightRadius: CARD_RADIUS,
        background: {
          type: 'linear-gradient',
          angle: 180,
          stops: [
            { color: t.variant === 'dark' ? 'rgba(24, 24, 24, 0)' : 'rgba(255, 255, 255, 0)', position: 0 },
            { color: t.surface, position: 1 },
          ],
        },
      }}
    />
  )
}

const ELSEWHERE: Record<Exclude<Page, 'home'> | 'settings', { icon: string; title: string }> = {
  notes: { icon: N.note, title: 'Notes' },
  tasks: { icon: N.tasks, title: 'Tasks' },
  pulls: { icon: N.pullRequest, title: 'Pull requests' },
  usage: { icon: N.usage, title: 'Usage' },
  settings: { icon: N.settings, title: 'Settings' },
}

function ElsewherePage({ page }: { page: Exclude<Page, 'home'> | 'settings' }) {
  const t = useTheme()
  const { icon, title } = ELSEWHERE[page]
  return (
    <div testId={`page-${page}`} style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: 10 }}>
      <Icon source={icon} size={28} color={t.iconTertiary} />
      <Label color={t.text} size={15}>
        {title}
      </Label>
      <Label color={t.textSecondary}>{`Not in the GPUIX build yet. Open the desktop app to use ${title}.`}</Label>
    </div>
  )
}
