// The window shell (`App.tsx`, `views/chrome.tsx`): a 46px title bar and a 52px
// rail painted on the frame surface, and one 12px-radius card holding the thread
// panel and the page. All geometry follows the desktop. The title bar, rail,
// palette and dialogs live in `nav/`; the thread panel in `Sidebar.tsx`.
import { FILL_ISLAND, ISLAND } from './MatrixLoader.tsx'
import { motion } from '@gpuix/react'
import { useEffect, useState, type ReactNode } from 'react'
import { UsagePage } from './usage/UsagePage.tsx'
import { PullRequestsPage } from './pulls/PullRequestsPage.tsx'
import { Composer } from './Composer.tsx'
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
import { SIDEBAR, TitleBar, usePanelOpen } from './nav/TitleBar.tsx'
import { Sidebar } from './Sidebar.tsx'
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
  const t = useTheme()
  const page = useNav((s) => s.page)
  const settingsOpen = useNav((s) => s.settingsOpen)
  const instant = useNav((s) => s.panelInstant)
  const panelOpen = usePanelOpen() && !settingsOpen
  // Keep the panel's rows mounted only while it shows or animates: hidden
  // elements still cost layout on every frame in GPUI.
  const [panelMounted, setPanelMounted] = useState(panelOpen)
  if (panelOpen && !panelMounted) setPanelMounted(true)
  const still = REDUCED_MOTION || instant
  if (still && !panelOpen && panelMounted) setPanelMounted(false)
  const edge = t.variant === 'dark' ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.10)'

  useEffect(() => {
    startLive()
    startNavHistory()
  }, [])

  return (
    <div
      testId="app-ready"
      // Any press makes later navigation pointer-driven again (`keyboardNav`).
      onMouseDown={pointerNav}
      style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', backgroundColor: t.frame }}
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
            animate={{ width: panelOpen ? SIDEBAR : 0 }}
            transition={still ? { duration: 0 } : SLIDE}
            onMotionComplete={() => setPanelMounted(panelOpen)}
            style={{ display: 'flex', height: '100%', flexShrink: 0, overflow: 'hidden' }}
          >
            {/* Cached islands (native/README.md): the panel, the content card, the title
                bar and the rail each replay while another of them animates. */}
            <div
              {...ISLAND}
              style={{
                display: 'flex',
                width: SIDEBAR,
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
              {panelMounted && <Sidebar />}
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
            <PageEnter page={settingsOpen ? 'settings' : page}>
              {settingsOpen ? <ElsewherePage page="settings" /> : page === 'home' ? <HomePage /> : page === 'usage' ? <UsagePage /> : page === 'pulls' ? <PullRequestsPage /> : <ElsewherePage page={page} />}
            </PageEnter>
          </div>
        </div>
      </div>
      <Palette />
      <HandoffDialog />
      <SessionsDialog />
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

function HomePage() {
  const thread = useApp((s) => s.open.thread)
  const selectedId = useApp((s) => s.selectedId)
  const blocking = useBlockingRequest()
  if (!selectedId) return <Draft />
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0, position: 'relative' }}>
      <Transcript />
      <BottomFade />
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, display: 'flex', justifyContent: 'center', paddingLeft: GUTTER, paddingRight: GUTTER, paddingBottom: 16 }}>
        {/* Pending approvals and questions stack on the composer; a blocking one replaces it. */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%', maxWidth: COLUMN }}>
          <ThreadRequests />
          {!blocking && <Composer thread={thread} />}
        </div>
      </div>
    </div>
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
