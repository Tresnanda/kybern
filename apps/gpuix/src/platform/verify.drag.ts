// Title-bar and rail drag regions with real OS input: CuaDriver posts HID
// press-drag-release gestures (foreground delivery; it holds the
// Accessibility grant this shell lacks) to a GPUIX window on a scratch daemon,
// and the window frame is read back from WindowServer. Empty title-bar and
// rail space moves the window with the cursor; controls, the thread title
// and the rail's button groups keep the press (Tauri `deep` drag regions).
// The same gesture on a plain AppKit window is the reference for how far a
// native title bar follows.
//
//   KYBERN_DATA_DIR=<scratch> bun src/platform/verify.drag.ts <thread id> <out.json>
//
// Double-click is not covered: CuaDriver's click and double_click events do
// not reach GPUIX windows (its drags do), see the platform9 report.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launch } from '@gpuix/react/automation'
import { assertScratchDataDir } from './verify.lib.ts'

const data = assertScratchDataDir()
const [thread = '', out = '/tmp/drag.json'] = process.argv.slice(2)
const CUA = '/Applications/CuaDriver.app/Contents/MacOS/cua-driver'
const call = (tool: string, args: object) => JSON.parse(execFileSync(CUA, ['call', tool, JSON.stringify(args)], { encoding: 'utf8' }))

function frame(pid: number) {
  const window = call('list_windows', { pid }).windows.find((w: { title: string }) => w.title) as { window_id: number; bounds: { x: number; y: number } }
  return { id: window.window_id, x: window.bounds.x, y: window.bounds.y }
}
/** Drag from (x, y) by (dx, dy) window points; returns how far the window moved. */
function drag(pid: number, x: number, y: number, dx: number, dy: number, durationMs = 600) {
  const before = frame(pid), session = `p9-drag-${process.pid}-${Math.random().toString(36).slice(2)}`
  for (let attempt = 0; ; attempt++) {
    const state = call('get_window_state', { pid, window_id: before.id, session, max_elements: 1 })
    const k = state.screenshot_width / state.window_bounds.width
    const result = call('drag', { pid, window_id: before.id, session, from_x: x * k, from_y: y * k, to_x: (x + dx) * k, to_y: (y + dy) * k, duration_ms: durationMs, steps: 30, delivery_mode: 'foreground' })
    if (result.code !== 'screenshot_context_missing' || attempt === 4) { assert.match(String(result.summary), /Posted drag/); break }
  }
  Bun.sleepSync(400)
  const after = frame(pid)
  return { cursor: [dx, dy], window: [after.x - before.x, after.y - before.y], from: [before.x, before.y] }
}

const results: Record<string, unknown> = {}
// Reference: a plain AppKit titled window.
const dir = mkdtempSync(path.join(tmpdir(), 'p9-native-window-'))
const source = path.join(dir, 'window.swift')
writeFileSync(source, `import AppKit
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let w = NSWindow(contentRect: NSRect(x: 300, y: 300, width: 600, height: 400), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
w.title = "p9-native-reference"
w.orderFrontRegardless()
DispatchQueue.main.asyncAfter(deadline: .now() + 60) { exit(0) }
app.run()
`)
execFileSync('swiftc', ['-O', source, '-o', path.join(dir, 'window')])
const native = spawn(path.join(dir, 'window'), [], { stdio: 'ignore' })
try {
  Bun.sleepSync(1500)
  results.nativeReference = { titleBar: drag(native.pid!, 300, 12, 100, 0), diagonal: drag(native.pid!, 300, 12, -100, 50) }
  console.log('native reference', JSON.stringify(results.nativeReference))
} finally { native.kill() }

const app = await launch({ command: 'bun', args: [path.join(import.meta.dir, '../main.tsx')], env: {
  GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: 'dark', KYBERN_WINDOW_SIZE: '1100x700', KYBERN_CLIENT_CONFIG_DIR: path.join(data, 'client-drag'),
  KYBERN_GPUIX_CREDENTIALS_DIR: path.join(data, 'creds'), KYBERN_GPUIX_THREAD: thread, KYBERN_URL: '', KYBERN_TOKEN: '',
} })
try {
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
  if (thread) await app.getByTestId('header-title').waitFor({ timeoutMs: 20_000 })
  const { pid } = await app.call('initialize', { protocolVersion: 1, client: 'drag-check' }) as { pid: number }
  // Every CuaDriver foreground gesture re-activates the app first (a click-through
  // drag on an inactive window), and how much of the path GPUIX then catches
  // varies (the native reference: 96-97%). Controls are asserted strictly; empty
  // regions must move the window along the gesture's main axis by at least 40%.
  // The raw distances are recorded in <out.json>.
  const moves = (r: { cursor: number[]; window: number[] }) => { const i = Math.abs(r.cursor[0]!) >= Math.abs(r.cursor[1]!) ? 0 : 1; return r.window[i]! / r.cursor[i]! >= 0.4 && r.window[i]! / r.cursor[i]! <= 1.1 }
  const still = (r: { window: number[] }) => r.window[0] === 0 && r.window[1] === 0
  // The first gesture after launch activates the app and may be absorbed; not asserted.
  drag(pid, 800, 22, 1, 0)
  const cases: [string, number, number, number, number, (r: { cursor: number[]; window: number[] }) => boolean][] = [
    ['empty title bar', 820, 22, 100, 0, moves],
    ['empty title bar, diagonal back', 860, 22, -100, -40, moves],
    ['empty title bar, vertical', 820, 22, 0, 60, moves],
    ['sidebar toggle (inside AppKit’s 28pt band)', 96, 22, 100, 40, still],
    ['sidebar toggle (below the band)', 96, 34, -100, -40, still],
    ['dock toggle', 1065, 22, -100, 40, still],
    ['thread title (desktop h2 is drag-region=false)', 500, 22, -60, 30, still],
    ['rail empty space', 26, 420, 80, 30, moves],
    ['rail button', 26, 112, 80, 30, still],
    ['rail gap between buttons', 26, 90, 60, 20, still],
    ['rail empty space, back', 26, 420, -80, -20, moves],
  ]
  for (const [label, x, y, dx, dy, expect] of cases) {
    const r = drag(pid, x, y, dx, dy)
    results[label] = r
    console.log(`${expect(r) ? 'ok  ' : 'FAIL'} ${label}: cursor ${r.cursor} → window ${r.window} (from ${r.from})`)
    assert.ok(expect(r), label)
  }
} finally { await app.close() }
writeFileSync(out, JSON.stringify(results, null, 2))
console.log('ok  title bar and rail drag regions follow the desktop with real OS input')
process.exit(0)
