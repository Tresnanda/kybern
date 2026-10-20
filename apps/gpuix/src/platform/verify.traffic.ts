// Traffic lights sit on the 46px title bar's midline (desktop
// `traffic_lights.rs`: centre y = 23 from the window top), at x = 16.
// Captures the real window with `screencapture -l` and finds the close
// button's painted extent, before and after a resize and a theme change.
//
//   KYBERN_DATA_DIR=<scratch> bun src/platform/verify.traffic.ts <out-dir>
import '../native/local-build.ts'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { launch } from '@gpuix/react/automation'
import { pixels } from '../../native/png.ts'
import { assertScratchDataDir, windowId } from './verify.lib.ts'

assertScratchDataDir()

const out = process.argv[2] ?? '/tmp/traffic'
mkdirSync(out, { recursive: true })

function measure(file: string, widthPt: number) {
  const img = pixels(file)
  const scale = img.w / widthPt
  // Background: the bar colour just left of the dots (x = 6pt, y = 23pt).
  const bg = img.at(6 * scale, 23 * scale)
  const differs = (x: number, y: number) => img.at(x, y).some((c, i) => Math.abs(c - bg[i]!) > 12)
  let top = Infinity, bottom = -1, left = Infinity, right = -1
  for (let y = 3 * scale; y < 44 * scale; y++) for (let x = 10 * scale; x < 32 * scale; x++) {
    if (!differs(x, y)) continue
    top = Math.min(top, y); bottom = Math.max(bottom, y); left = Math.min(left, x); right = Math.max(right, x)
  }
  assert.ok(bottom >= 0, `no close button found in ${file}`)
  return { scale, top: top / scale, bottom: (bottom + 1) / scale, left: left / scale, centreY: (top + bottom + 1) / 2 / scale, height: (bottom + 1 - top) / scale }
}

for (const theme of ['dark', 'light'] as const) {
  const app = await launch({ command: 'bun', args: [path.join(import.meta.dir, '../main.tsx')], env: { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: theme, KYBERN_WINDOW_SIZE: '1280x820' } })
  try {
    await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
    const { pid } = await app.call('initialize', { protocolVersion: 1, client: 'traffic-check' }) as { pid: number }
    const id = windowId(pid)
    const file = path.join(out, `traffic-${theme}.png`)
    // Wait for AppKit's post-show relayout (the reset the desktop re-insets against).
    await new Promise((r) => setTimeout(r, 1500))
    execFileSync('screencapture', ['-x', '-o', '-l', String(id), file])
    const m = measure(file, 1280)
    console.log(theme, JSON.stringify(m))
    assert.ok(Math.abs(m.centreY - 23) <= 0.5, `close button centre ${m.centreY}pt, expected 23pt`)
    assert.ok(Math.abs(m.left - 16) <= 1, `close button left ${m.left}pt, expected 16pt`)
  } finally { await app.close() }
}
console.log('ok  traffic lights centred on the 46px bar in dark and light')
