/**
 * The shared layer of the cross-platform on-screen checks (WP7, PORTING-PLATFORMS.md).
 *
 * A check launches a lab (or the app) with `launchFixture`, drives it through the addon's automation client (`mouse.*`,
 * `press`, `getPaintedText`, bounds, all of which synthesize input inside the process, so there is no NSEvent, cliclick or
 * xdotool) and captures PNGs. This module is the only place that knows how the capture differs per OS:
 *
 *   macOS    the addon's `app.screenshot` (GPUI renders the scene), as every check has always done; `webViews: true`
 *            captures the real window instead (Swift window id + `screencapture -l`), the only way to see an embedded
 *            web view.
 *   Windows  `app.screenshot` (Direct3D 11 on WARP in CI).
 *   Linux    `app.screenshot` (GPUI renders the scene through a wgpu readback; lavapipe under Xvfb in CI). An addon
 *            without it falls back to the window's pixels from the X server (`xwininfo` + ImageMagick `import`, under
 *            Xvfb started with `-extension Composite`: otherwise GPUI's window takes the 32-bit visual, is redirected
 *            off-screen and captures black). `KYBERN_CHECK_CAPTURE=addon|x11` forces one. The first capture logs which.
 *
 * Software rendering (lavapipe, WARP) is not bit-identical to Metal, so pixel assertions go through `tolerance` and
 * structure (bounds, painted text, same-renderer A/B equality) rather than golden hashes.
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { launchFixture } from '../src/requests/harness.ts'
import { NATIVE_ARCH } from '../src/native/local-build.ts'
import { pngPixels } from './clip-pixels.ts'

export { launchFixture, pngPixels }
export type Fixture = Awaited<ReturnType<typeof launchFixture>>
export type Platform = 'macos' | 'linux' | 'windows'

export const platform: Platform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux'
/** CI renders in software off macOS (lavapipe, WARP); `KYBERN_CHECK_SOFTWARE=1` applies the same slack on a Mac. */
export const software = platform !== 'macos' || process.env.KYBERN_CHECK_SOFTWARE === '1'
/** `KYBERN_CHECK_STRICT=1` turns every known gap (see `step`) into a failure: use it once the gap's work package has landed. */
export const strict = process.env.KYBERN_CHECK_STRICT === '1'
/**
 * Per-channel colour slack for pixel assertions. macOS keeps the value the checks have always used; software
 * renderers get more room for blending and rounding differences.
 */
export const tolerance = Number(process.env.KYBERN_CHECK_TOLERANCE ?? (software ? 8 : 3))

const here = import.meta.dir

/** The check's output directory: `KYBERN_VERIFY_OUTPUT`, else `native/build/<name>`. */
export function outputDir(name: string): string {
  const dir = process.env.KYBERN_VERIFY_OUTPUT ?? path.join(here, 'build', name)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * `launchFixture` refuses to run without a scratch `KYBERN_DATA_DIR`. A runner sets one; run by hand, a throwaway
 * directory under the temp folder keeps the real `~/.kybern` out of reach. Returns the directory.
 */
export function scratchDataDir(): string {
  if (!process.env.KYBERN_DATA_DIR) {
    const dir = path.join(tmpdir(), `kybern-gpuix-check-${process.pid}`)
    mkdirSync(dir, { recursive: true })
    process.env.KYBERN_DATA_DIR = dir
  }
  return process.env.KYBERN_DATA_DIR
}

/** `launchFixture` with the scratch data directory ensured and `GPUIX_BACKGROUND=1` (no focus stealing) as the default. */
export function launch(entry: string, env: Record<string, string> = {}, observe?: Parameters<typeof launchFixture>[2]) {
  scratchDataDir()
  return launchFixture(entry, { GPUIX_BACKGROUND: '1', ...env }, observe)
}

// ---- known gaps and the report ----

/** A native capability a work package still owes the platform; a step that needs it is a known gap off macOS. */
export const GAPS = {
  /** `scroll_hooks.py` injects the wheel phase through a macOS-only call (WP1 unifies it). */
  wheel: 'wheel input: scroll phase injection is macOS-only until WP1 unifies it',
  /** Off macOS the shortcut key is Ctrl since WP3 (`isPrimary`); a pass here reports the gap closed, then the marker goes. */
  shortcut: 'Ctrl shortcuts off macOS: WP3 (isPrimary) not yet confirmed on this platform',
  /** Menlo, the code face the labs name, is macOS-only; positions derived from its advances move (WP8). */
  font: 'Menlo glyph advances: off macOS the face falls back, so positions computed from its metrics move',
} as const

function report(event: Record<string, unknown>) {
  const file = process.env.KYBERN_CHECK_REPORT
  if (file) appendFileSync(file, JSON.stringify({ check: process.env.KYBERN_CHECK_NAME ?? path.basename(process.argv[1] ?? ''), at: new Date().toISOString(), ...event }) + '\n')
}

/**
 * Run one named part of a check. With `gap`, the part depends on a capability that is blocked off macOS: a failure there
 * (software rendering only, and not under `KYBERN_CHECK_STRICT=1`) is recorded as a known gap instead of failing the
 * check, and a pass says the gap closed so the marker can be removed. Without `gap` the error propagates.
 */
export async function step<T>(label: string, run: () => Promise<T> | T, options: { gap?: string } = {}): Promise<T | undefined> {
  try {
    const value = await run()
    if (options.gap && platform !== 'macos') {
      console.log(`gap closed ${label}: ${options.gap}`)
      report({ step: label, status: 'gap-closed', detail: options.gap })
    } else report({ step: label, status: 'ok' })
    return value
  } catch (error) {
    if (options.gap && platform !== 'macos' && !strict) {
      const detail = `${options.gap}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`
      console.log(`KNOWN GAP ${label}: ${detail}`)
      report({ step: label, status: 'gap', detail })
      return undefined
    }
    report({ step: label, status: 'fail', detail: error instanceof Error ? error.message.split('\n')[0] : String(error) })
    throw error
  }
}

/**
 * Poll `read` until `done` holds or `timeoutMs` passes, and return the last value. Off macOS a click returns before its
 * JS handler, React's commit, the queued invalidation and the next drawn frame (bounds are recorded at paint), so a
 * check that reads layout right after input must wait for it rather than for a fixed clock step.
 */
export async function settled<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let value = await read()
  while (!done(value) && Date.now() < deadline) {
    await Bun.sleep(50)
    value = await read()
  }
  return value
}

// ---- capture ----

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
function assertPng(file: string, how: string) {
  assert.ok(existsSync(file) && statSync(file).size > 64, `${how} wrote no image to ${file}`)
  assert.ok(readFileSync(file).subarray(0, 8).equals(PNG_SIGNATURE), `${how} did not write a PNG (${file})`)
}

/** One top-level X window from `xwininfo -root -tree`. */
export interface XWindow { id: string; width: number; height: number; x: number; y: number }
/**
 * The root's direct children that are windows a user could see: from `xwininfo -root -tree`, where depth is the
 * indentation. Largest first, so the app's window comes before helper windows (input methods, clipboard owners).
 */
export function parseXwininfoTree(text: string): XWindow[] {
  const out: XWindow[] = []
  let indent = -1
  for (const line of text.split('\n')) {
    const m = line.match(/^(\s+)(0x[0-9a-f]+)\s+(?:"[^"]*"|\(has no name\))(?::\s*\(.*?\))?\s+(\d+)x(\d+)\+(-?\d+)\+(-?\d+)/i)
    // The first window line after the root's "N children:" header sets the depth of the root's children.
    if (!m || (indent >= 0 && m[1]!.length !== indent)) continue
    if (indent < 0) indent = m[1]!.length
    out.push({ id: m[2]!, width: Number(m[3]), height: Number(m[4]), x: Number(m[5]), y: Number(m[6]) })
  }
  return out.filter(w => w.width >= 200 && w.height >= 150).sort((a, b) => b.width * b.height - a.width * a.height)
}

function captureX11(file: string) {
  if (!process.env.DISPLAY) throw new Error('the addon screenshot failed and there is no X display to capture (Wayland session?)')
  let target = 'root'
  try {
    const windows = parseXwininfoTree(execFileSync('xwininfo', ['-root', '-tree'], { encoding: 'utf8', timeout: 15_000 }))
    if (windows[0]) target = windows[0].id
  } catch (error) {
    console.log(`[harness] xwininfo failed (${error instanceof Error ? error.message.split('\n')[0] : error}); capturing the whole display`)
  }
  // PNG32: 8-bit RGBA, which is what the PNG reader in clip-pixels.ts takes (ImageMagick would pick a palette for flat images).
  execFileSync('import', ['-window', target, `PNG32:${file}`], { timeout: 30_000 })
}

let linuxCapture: 'addon' | 'x11' | null = (process.env.KYBERN_CHECK_CAPTURE as 'addon' | 'x11' | undefined) ?? null
const announce = (how: string) => console.log(`[harness] capture: ${how} (${platform}${software ? ', software rendering' : ''})`)

/**
 * Capture the fixture's window to `file` and return it. `webViews` asks for the real window on macOS, which includes
 * embedded web views (the automation screenshot omits them); elsewhere there is no embedded web view to see, so it is the
 * ordinary capture.
 */
export async function capture(f: Fixture, file: string, options: { webViews?: boolean } = {}): Promise<string> {
  mkdirSync(path.dirname(file), { recursive: true })
  if (platform === 'macos' && options.webViews) {
    const { captureWindow } = await import('../src/transcript/live.ts')
    captureWindow(f.pid, file)
    assertPng(file, 'screencapture')
    return file
  }
  if (platform === 'linux' && linuxCapture !== 'addon') {
    if (linuxCapture === 'x11') { captureX11(file); assertPng(file, 'import'); return file }
    try {
      await f.app.screenshot({ path: file })
      assertPng(file, 'the addon screenshot')
      linuxCapture = 'addon'
      announce('addon screenshot')
      return file
    } catch (error) {
      console.log(`[harness] the addon screenshot is not usable on Linux (${error instanceof Error ? error.message.split('\n')[0] : error}); using the X server`)
      linuxCapture = 'x11'
      captureX11(file)
      assertPng(file, 'import')
      announce('X server (xwininfo + import)')
      return file
    }
  }
  await f.app.screenshot({ path: file })
  assertPng(file, 'the addon screenshot')
  if (linuxCapture === null) { linuxCapture = 'addon'; announce('addon screenshot') }
  return file
}

/** Capture until `done(file)` holds or `timeoutMs` passes; the last capture stays in `file`. Off macOS a synthesized
 * wheel or click reaches GPUI on its UI thread after the call returns, so a single capture can race it. */
export async function captureSettled(f: Fixture, file: string, done: (file: string) => boolean, timeoutMs = 3000): Promise<string> {
  return settled(() => capture(f, file), done, timeoutMs)
}

// ---- pixels ----

export type Png = ReturnType<typeof pngPixels>
export type Rect = { x: number; y: number; width: number; height: number }

/** Every channel within `tol` (default `tolerance`). */
export const near = (a: readonly number[], b: readonly number[], tol = tolerance) => a.every((v, i) => Math.abs(v - b[i]!) <= tol)

/** Pixels of the logical rectangle `rect`, sampled on a grid (`step` logical px), as `[r, g, b]` triples. */
export function sample(png: Png, scale: number, rect: Rect, stepPx = 2): number[][] {
  const out: number[][] = []
  for (let y = rect.y; y < rect.y + rect.height; y += stepPx) {
    for (let x = rect.x; x < rect.x + rect.width; x += stepPx) {
      const px = Math.min(png.width - 1, Math.max(0, Math.floor(x * scale))), py = Math.min(png.height - 1, Math.max(0, Math.floor(y * scale)))
      out.push(png.at(px, py))
    }
  }
  return out
}

/** The rectangle holds painted content: at least `min` sampled pixels differ from its most common colour by more than `tolerance`. */
export function assertPainted(png: Png, scale: number, rect: Rect, label: string, min = 12) {
  const counts = new Map<string, number>()
  const pixels = sample(png, scale, rect)
  for (const p of pixels) counts.set(String(p), (counts.get(String(p)) ?? 0) + 1)
  const common = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0].split(',').map(Number) ?? [0, 0, 0]
  const differing = pixels.filter(p => !near(p, common)).length
  assert.ok(differing >= min, `${label}: expected painted content, found ${differing} differing samples in ${Math.round(rect.width)}x${Math.round(rect.height)} at ${Math.round(rect.x)},${Math.round(rect.y)}`)
}

const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc32 = (bytes: Uint8Array) => { let c = 0xffffffff; for (const b of bytes) c = CRC[(c ^ b) & 255]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
const pngChunk = (kind: string, data: Uint8Array) => {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0); out.write(kind, 4, 'ascii'); Buffer.from(data).copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}
/** Write the logical rectangle `rect` of a capture as its own PNG (a title bar, a control), at the capture's scale. */
export function writeCrop(png: Png, scale: number, rect: Rect, file: string): string {
  const x0 = Math.max(0, Math.floor(rect.x * scale)), y0 = Math.max(0, Math.floor(rect.y * scale))
  const width = Math.max(1, Math.min(png.width - x0, Math.round(rect.width * scale))), height = Math.max(1, Math.min(png.height - y0, Math.round(rect.height * scale)))
  const raw = Buffer.alloc(height * (width * 3 + 1))
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw.set(png.at(x0 + x, y0 + y), y * (width * 3 + 1) + 1 + x * 3)
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', new Uint8Array())]))
  return file
}

/** The two rectangles differ somewhere (a click, a hover or a theme really changed what is drawn). */
export function assertDiffers(a: Png, b: Png, scale: number, rect: Rect, label: string) {
  const left = sample(a, scale, rect, 1), right = sample(b, scale, rect, 1)
  assert.ok(left.some((p, i) => !near(p, right[i]!)), `${label}: the region did not change`)
}

/**
 * Where the addon the second ("before") run of an A/B comparison loads: `build/markdown-before.node` when kept, else the
 * addon this process uses (`NAPI_RS_NATIVE_LIBRARY_PATH`, else the build for this OS).
 */
export function beforeAddon(): string {
  const kept = path.join(here, 'build/markdown-before.node')
  if (existsSync(kept)) return kept
  return process.env.NAPI_RS_NATIVE_LIBRARY_PATH ?? path.join(here, `build/gpuix-native.${NATIVE_ARCH}.node`)
}
