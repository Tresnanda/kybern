// The window's own buttons on Windows and Linux (WP3); macOS keeps the traffic lights (`main.tsx` places them).
//
// - Windows 11: minimize, maximize/restore and close flush with the top-right corner, 46 px wide and the title bar's
//   height, 10 px Fluent-style glyphs; neutral hover and press fills, the close button's red (#C42B1C) with a white
//   glyph. Each is a `windowControl` element: Windows answers its hit test as that caption button, so the click, the
//   Snap Layouts flyout on hovering maximize and the window's state stay native. No `onClick` there.
// - Linux with client-side decorations: GNOME's round 24 px buttons with a faint fill, in the desktop's order and on its
//   side (`buttonLayout`, from `gtk-decoration-layout`); only what the compositor supports (`controls`). With server-side
//   decorations the window manager draws them and none show here. `ResizeEdges` resizes the window from its edges.
//
// Both dim their glyphs while the window is inactive, as the platforms do. `useWindowControlsLayout` gives the title bar
// the room they take, so the leading controls start after them and the trailing toggles end before them.
import { useState } from 'react'
import { Icon } from '../icons.tsx'
import { useControls } from '../kit/controls.ts'
import { useTheme } from '../ui.tsx'
import { useWindowChrome, windowActions, type ResizeEdge, type WindowButton, type WindowChrome } from '../shell/windowChrome.ts'
import { TITLEBAR } from './TitleBar.tsx'

const MAC = process.platform === 'darwin'
/** Where the macOS traffic lights end: the leading chrome starts here. */
const TRAFFIC_LIGHTS_END = 82
const EDGE = 12

const svg = (body: string, box: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="${box}" height="${box}" viewBox="0 0 ${box} ${box}" fill="none">${body}</svg>`
/** Segoe Fluent Icons' caption glyphs (E921, E922, E923, E8BB), drawn on the 10 px grid at a 1 px stroke. */
const FLUENT = {
  minimize: svg('<path d="M0 5.5H10" stroke="#000"/>', 10),
  maximize: svg('<rect x="0.5" y="0.5" width="9" height="9" rx="1.5" stroke="#000"/>', 10),
  restore: svg('<rect x="0.5" y="2.5" width="7" height="7" rx="1.5" stroke="#000"/><path d="M2.5 2.5V2a1.5 1.5 0 0 1 1.5-1.5h4A1.5 1.5 0 0 1 9.5 2v4A1.5 1.5 0 0 1 8 7.5h-.5" stroke="#000"/>', 10),
  close: svg('<path d="M0.5 0.5L9.5 9.5M9.5 0.5L0.5 9.5" stroke="#000"/>', 10),
}
/** Adwaita's `window-*-symbolic` glyphs on a 16 px grid. */
const ADWAITA = {
  minimize: svg('<path d="M4 11.25H12" stroke="#000" stroke-width="1.5" stroke-linecap="round"/>', 16),
  maximize: svg('<rect x="4.25" y="4.25" width="7.5" height="7.5" rx="1.25" stroke="#000" stroke-width="1.5"/>', 16),
  restore: svg('<rect x="4.25" y="6.25" width="5.5" height="5.5" rx="1" stroke="#000" stroke-width="1.5"/><path d="M6.75 4.25h4a1 1 0 0 1 1 1v4" stroke="#000" stroke-width="1.5" stroke-linecap="round"/>', 16),
  close: svg('<path d="M5 5L11 11M11 5L5 11" stroke="#000" stroke-width="1.5" stroke-linecap="round"/>', 16),
}

const WINDOWS_BUTTON = 46
const GNOME_BUTTON = 24
const GNOME_GAP = 6

type Kind = 'minimize' | 'maximize' | 'restore' | 'close'
const LABEL: Record<Kind, string> = { minimize: 'Minimize', maximize: 'Maximize', restore: 'Restore', close: 'Close' }

/** The Linux buttons on one side: the desktop's order, minus what this window or compositor cannot do. */
function linuxButtons(chrome: WindowChrome, side: 'left' | 'right'): WindowButton[] {
  const layout = chrome.buttonLayout ?? { left: [], right: ['minimize', 'maximize', 'close'] }
  return layout[side].filter((button) => button === 'close' || (button === 'minimize' ? chrome.controls.minimize && chrome.minimizable : chrome.controls.maximize && chrome.resizable))
}

const linuxDrawn = (chrome: WindowChrome | null): chrome is WindowChrome => chrome?.platform === 'linux' && chrome.decorations === 'client' && !chrome.fullscreen
const gnomeWidth = (n: number) => (n ? n * GNOME_BUTTON + (n - 1) * GNOME_GAP + EDGE : 0)

/** Room the window buttons take at each end of the title bar: `leading` is where the app's own leading chrome starts. */
export function useWindowControlsLayout(): { leading: number; trailing: number } {
  const chrome = useWindowChrome()
  if (MAC) return { leading: TRAFFIC_LIGHTS_END, trailing: 0 }
  if (chrome?.platform === 'windows' && !chrome.fullscreen) return { leading: EDGE, trailing: 3 * WINDOWS_BUTTON }
  if (linuxDrawn(chrome)) {
    const left = linuxButtons(chrome, 'left').length, right = linuxButtons(chrome, 'right').length
    return { leading: left ? gnomeWidth(left) + EDGE : EDGE, trailing: gnomeWidth(right) }
  }
  return { leading: EDGE, trailing: 0 }
}

/** The window buttons for one end of the title bar (absolutely placed in it); nothing on macOS. */
export function WindowControls({ side }: { side: 'left' | 'right' }) {
  const chrome = useWindowChrome()
  if (MAC || !chrome || chrome.fullscreen) return null
  if (chrome.platform === 'windows') {
    if (side === 'left') return null
    return (
      <div testId="window-controls" style={{ position: 'absolute', top: 0, right: 0, height: TITLEBAR, display: 'flex' }}>
        <CaptionButton kind="minimize" chrome={chrome} />
        <CaptionButton kind={chrome.maximized ? 'restore' : 'maximize'} chrome={chrome} />
        <CaptionButton kind="close" chrome={chrome} />
      </div>
    )
  }
  if (!linuxDrawn(chrome)) return null
  const buttons = linuxButtons(chrome, side)
  if (!buttons.length) return null
  return (
    <div testId={`window-controls${side === 'left' ? '-left' : ''}`} style={{ position: 'absolute', top: 0, height: TITLEBAR, display: 'flex', alignItems: 'center', gap: GNOME_GAP, ...(side === 'left' ? { left: EDGE } : { right: EDGE }) }}>
      {buttons.map((button) => <GnomeButton key={button} kind={button === 'maximize' && chrome.maximized ? 'restore' : button} chrome={chrome} />)}
    </div>
  )
}

function CaptionButton({ kind, chrome }: { kind: Kind; chrome: WindowChrome }) {
  const t = useTheme()
  const c = useControls()
  const [hover, setHover] = useState(false)
  const close = kind === 'close'
  const enabled = close || (kind === 'minimize' ? chrome.minimizable : chrome.resizable)
  const rest = chrome.active ? t.text : t.textSecondary
  const fg = !enabled ? c.disabled.fg : close && hover ? '#FFFFFF' : rest
  return (
    <div
      testId={`window-${kind === 'restore' ? 'maximize' : kind}`}
      role="button"
      aria-label={LABEL[kind]}
      windowControl={kind === 'restore' ? 'maximize' : kind}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', width: WINDOWS_BUTTON, height: TITLEBAR,
        ...(enabled ? {
          hover: { backgroundColor: close ? '#C42B1C' : c.ghost.hover },
          active: { backgroundColor: close ? 'rgba(196, 43, 28, 0.9)' : c.ghost.press },
        } : {}),
      }}
    >
      <Icon source={FLUENT[kind]} size={10} color={fg} style={{ pointerEvents: 'none' }} />
    </div>
  )
}

function GnomeButton({ kind, chrome }: { kind: Kind; chrome: WindowChrome }) {
  const t = useTheme()
  const dark = t.variant === 'dark'
  const fill = (a: number) => (dark ? `rgba(255, 255, 255, ${a})` : `rgba(0, 0, 0, ${a})`)
  const act = kind === 'minimize' ? windowActions.minimize : kind === 'close' ? windowActions.close : windowActions.toggleMaximize
  return (
    <div
      testId={`window-${kind === 'restore' ? 'maximize' : kind}`}
      role="button"
      aria-label={LABEL[kind]}
      onClick={() => act()}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', width: GNOME_BUTTON, height: GNOME_BUTTON, borderRadius: GNOME_BUTTON / 2,
        backgroundColor: fill(0.08),
        hover: { backgroundColor: fill(0.14) },
        active: { backgroundColor: fill(0.24) },
      }}
    >
      <Icon source={ADWAITA[kind]} size={16} color={chrome.active ? t.text : t.textSecondary} style={{ pointerEvents: 'none' }} />
    </div>
  )
}

const RESIZE_EDGE = 5
const RESIZE_CORNER = 12
const CURSOR: Record<ResizeEdge, string> = {
  top: 'ns-resize', bottom: 'ns-resize', left: 'ew-resize', right: 'ew-resize',
  'top-left': 'nwse-resize', 'bottom-right': 'nwse-resize', 'top-right': 'nesw-resize', 'bottom-left': 'nesw-resize',
}

/**
 * Linux client-side decorations: the compositor draws no frame, so the window resizes from a 5 px band inside each
 * edge (12 px at the corners), as GTK apps do. Tiled or maximized edges have none. Painted last, over everything.
 */
export function ResizeEdges() {
  const chrome = useWindowChrome()
  if (!linuxDrawn(chrome) || chrome.maximized || !chrome.resizable) return null
  const tiled = chrome.tiling ?? { top: false, left: false, right: false, bottom: false }
  const zone = (edge: ResizeEdge, style: object) => (
    <div
      key={edge}
      testId={`resize-${edge}`}
      onMouseDown={(e) => { if ((e.button ?? 0) === 0) windowActions.resize(edge) }}
      style={{ position: 'absolute', cursor: CURSOR[edge], ...style } as never}
    />
  )
  const top = !tiled.top, bottom = !tiled.bottom, left = !tiled.left, right = !tiled.right
  return (
    <>
      {top && zone('top', { top: 0, left: RESIZE_CORNER, right: RESIZE_CORNER, height: RESIZE_EDGE })}
      {bottom && zone('bottom', { bottom: 0, left: RESIZE_CORNER, right: RESIZE_CORNER, height: RESIZE_EDGE })}
      {left && zone('left', { left: 0, top: RESIZE_CORNER, bottom: RESIZE_CORNER, width: RESIZE_EDGE })}
      {right && zone('right', { right: 0, top: RESIZE_CORNER, bottom: RESIZE_CORNER, width: RESIZE_EDGE })}
      {top && left && zone('top-left', { top: 0, left: 0, width: RESIZE_CORNER, height: RESIZE_CORNER })}
      {top && right && zone('top-right', { top: 0, right: 0, width: RESIZE_CORNER, height: RESIZE_CORNER })}
      {bottom && left && zone('bottom-left', { bottom: 0, left: 0, width: RESIZE_CORNER, height: RESIZE_CORNER })}
      {bottom && right && zone('bottom-right', { bottom: 0, right: 0, width: RESIZE_CORNER, height: RESIZE_CORNER })}
    </>
  )
}
