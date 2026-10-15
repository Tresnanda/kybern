// Kybern on GPUIX: the desktop client's look, painted by Zed's GPUI instead of
// a web view. Run with `pnpm dev` (hot reload) or `pnpm start`.
// Must stay the first import: it picks the native module before @gpuix loads.
import './native/local-build.ts'
import { fstatSync, readFileSync } from 'node:fs'
import { render, useGpuixRequired } from '@gpuix/react'
import { useEffect, useState, type ReactNode } from 'react'
import { App } from './App.tsx'
import { onWindowKeyDown } from './nav/keys.ts'
import { appearance } from './settings/appearance.ts'
import { connect } from './state.ts'
import { ThemeProvider, VARIANT } from './ui.tsx'
import { startPerfProbe } from './perf/probe.ts'
import { installDesktopMaterial } from './native/material.ts'
import { hasSavedFrame, installWindowFrame, startWindowShell } from './shell/window.ts'

const FONTS = ['CalSans-Regular.ttf', 'JetBrainsMono-Regular.ttf']

function Fonts({ children }: { children: ReactNode }) {
  const renderer = useGpuixRequired()
  const [ready, setReady] = useState(false)
  useEffect(() => {
    // `registerFont` landed after @gpuix/native 0.10.0; until then the UI
    // falls back to installed fonts (SF Pro, Menlo).
    const register = (renderer as { registerFont?: (bytes: Uint8Array) => void }).registerFont
    for (const file of register ? FONTS : []) {
      try {
        register!.call(renderer, readFileSync(new URL(`./assets/fonts/${file}`, import.meta.url)))
      } catch (error) {
        console.error(`[fonts] ${file}:`, error)
      }
    }
    setReady(true)
    startPerfProbe(renderer)
    startWindowShell(renderer)
    // Debug: minimize after launch to check that hidden windows stop their loops.
    if (process.env.KYBERN_DEBUG_MINIMIZE) setTimeout(() => renderer.minimizeWindow?.(), Number(process.env.KYBERN_DEBUG_MINIMIZE))
  }, [renderer])
  return ready ? children : null
}

connect()

render(
  <ThemeProvider>
    <Fonts>
      <App />
    </Fonts>
  </ThemeProvider>,
  {
    title: 'Kybern',
    appName: 'Kybern',
    width: 1280,
    height: 820,
    titlebarTransparent: true,
    // The desktop's macOS window is translucent (under-window vibrancy) with
    // the frame painted at 88% over it.
    windowBackground: process.env.KYBERN_OPAQUE === '1' || !appearance().translucent ? 'opaque' : 'blurred',
    trafficLightX: 16,
    trafficLightY: 16,
    ...(process.env.KYBERN_PERF_PROBE === '1' ? { debugFrameOverlay: 'minimal' as const } : {}),
    minWidth: 900,
    minHeight: 600,
    // An agent checking its own work must not take the keyboard from the user.
    focus: process.env.GPUIX_BACKGROUND !== '1',
    // A saved frame is restored before the window is shown (`shell/window.ts`).
    show: !hasSavedFrame(),
    // Window shortcuts (⌘N, ⌘B, ⌘K, ⌘[ ⌘], ⌘↑, ⌘,): `nav/keys.ts`.
    onKeyDown: onWindowKeyDown,
  },
)

// Put the window back where it was (size and position are saved as it moves).
installWindowFrame()

// GPUI's blur is colourless; give it the desktop's vibrancy material.
if (process.env.KYBERN_OPAQUE !== '1' && appearance().translucent) installDesktopMaterial(process.env.KYBERN_APPEARANCE || appearance().theme === 'system' ? VARIANT : appearance().theme as 'light' | 'dark')

// Automation drives the app over a stdin pipe (`@gpuix/react/automation`). If the
// driving script dies without `close()`, the pipe ends: quit instead of
// lingering as an orphaned window.
if (process.env.GPUIX_BACKGROUND === '1' && isPipe(0)) {
  process.stdin.on('end', () => process.exit(0))
  process.stdin.on('close', () => process.exit(0))
}

function isPipe(fd: number): boolean {
  try {
    // Bun and Node spawn pipes as socket pairs on macOS; a shell pipe is a FIFO.
    const stat = fstatSync(fd)
    return stat.isFIFO() || stat.isSocket()
  } catch {
    return false
  }
}
