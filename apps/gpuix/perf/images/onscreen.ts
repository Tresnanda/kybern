import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

/** Reject measurements and captures when macOS puts the fixture in another Space. */
export async function assertBuiltInWindow(pid: number): Promise<void> {
  let output = ''
  // The test-id handshake can complete just before AppKit publishes the window.
  for (let attempt = 0; attempt < 20; attempt++) {
    output = execFileSync('swift', ['/Users/mymac/projects/ade-gpuix-scratch/window-onscreen.swift', String(pid)], { encoding: 'utf8' })
    if (output.includes('onscreen=true')) break
    await Bun.sleep(250)
  }
  const windows = [...output.matchAll(/window \d+ onscreen=true bounds=\{([^}]+)\}/g)].map(match => match[1])
  assert(windows.length > 0, `GPUIX window is offscreen: ${output.trim() || `pid ${pid} has no window`}`)
  const withinDisplay = windows.some(line => {
    const bounds = Object.fromEntries([...line.matchAll(/\b(X|Y|Width|Height)\s*[:=]\s*(-?\d+(?:\.\d+)?)/g)].map(([, key, value]) => [key, Number(value)]))
    return Number.isFinite(bounds.X) && Number.isFinite(bounds.Y) && Number.isFinite(bounds.Width) && Number.isFinite(bounds.Height)
      && bounds.X >= 0 && bounds.Y >= 0 && bounds.Width > 0 && bounds.Height > 0
      && bounds.X + bounds.Width <= 1440 && bounds.Y + bounds.Height <= 900
  })
  assert(withinDisplay, `GPUIX window is outside the built-in display: ${output.trim()}`)
}
