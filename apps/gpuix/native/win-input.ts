// Windows-only test helpers for the embedded web view (`webview-win-check.ts`) and the title bar (`scripts/window-chrome-check.ts`): real OS input through user32 (the
// automation client's events go to GPUI directly and would skip the host's window filter) and captures of the
// composed window, which include the WebView2 visuals that GPUI's own `screenshot` never sees.
import { dlopen, FFIType, JSCallback, ptr } from 'bun:ffi'
import { writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const user32 = dlopen('user32.dll', {
  SetCursorPos: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  mouse_event: { args: [FFIType.u32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.u64], returns: FFIType.void },
  keybd_event: { args: [FFIType.u8, FFIType.u8, FFIType.u32, FFIType.u64], returns: FFIType.void },
  GetClientRect: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
  ClientToScreen: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
  GetDpiForWindow: { args: [FFIType.u64], returns: FFIType.u32 },
  GetDC: { args: [FFIType.u64], returns: FFIType.u64 },
  ReleaseDC: { args: [FFIType.u64, FFIType.u64], returns: FFIType.i32 },
  PrintWindow: { args: [FFIType.u64, FFIType.u64, FFIType.u32], returns: FFIType.i32 },
  GetForegroundWindow: { args: [], returns: FFIType.u64 },
  // Window state for the title-bar check (`scripts/window-chrome-check.ts`, WP3).
  EnumWindows: { args: [FFIType.ptr, FFIType.i64], returns: FFIType.i32 },
  GetWindowThreadProcessId: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.u32 },
  IsWindowVisible: { args: [FFIType.u64], returns: FFIType.i32 },
  IsZoomed: { args: [FFIType.u64], returns: FFIType.i32 },
  IsIconic: { args: [FFIType.u64], returns: FFIType.i32 },
  GetWindowRect: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
  ShowWindow: { args: [FFIType.u64, FFIType.i32], returns: FFIType.i32 },
  IsWindow: { args: [FFIType.u64], returns: FFIType.i32 },
  SendMessageW: { args: [FFIType.u64, FFIType.u32, FFIType.u64, FFIType.i64], returns: FFIType.i64 },
}).symbols
const gdi32 = dlopen('gdi32.dll', {
  CreateCompatibleDC: { args: [FFIType.u64], returns: FFIType.u64 },
  CreateCompatibleBitmap: { args: [FFIType.u64, FFIType.i32, FFIType.i32], returns: FFIType.u64 },
  SelectObject: { args: [FFIType.u64, FFIType.u64], returns: FFIType.u64 },
  BitBlt: { args: [FFIType.u64, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.u64, FFIType.i32, FFIType.i32, FFIType.u32], returns: FFIType.i32 },
  GetDIBits: { args: [FFIType.u64, FFIType.u64, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  DeleteObject: { args: [FFIType.u64], returns: FFIType.i32 },
  DeleteDC: { args: [FFIType.u64], returns: FFIType.i32 },
}).symbols

/** A GPUI window: its HWND (`created` event `windowNumber`) and device pixels per point. */
export function windowOf(hwnd: number) {
  const scale = (user32.GetDpiForWindow(BigInt(hwnd)) || 96) / 96
  const client = () => {
    const rect = new Int32Array(4), origin = new Int32Array(2)
    user32.GetClientRect(BigInt(hwnd), ptr(rect)); user32.ClientToScreen(BigInt(hwnd), ptr(origin))
    return { x: origin[0]!, y: origin[1]!, width: rect[2]!, height: rect[3]! }
  }
  /** Window points (as GPUI and `webHost.place` use them) to screen pixels. */
  const screen = (x: number, y: number) => { const c = client(); return [Math.round(c.x + x * scale), Math.round(c.y + y * scale)] as const }
  return { hwnd, scale, client, screen, foreground: () => Number(user32.GetForegroundWindow()) === hwnd }
}

const MOVE = 0x0001, LEFT_DOWN = 0x0002, LEFT_UP = 0x0004, WHEEL = 0x0800, KEY_UP = 0x0002
export async function click(window: ReturnType<typeof windowOf>, x: number, y: number, count = 1) {
  const [sx, sy] = window.screen(x, y)
  user32.SetCursorPos(sx, sy); user32.mouse_event(MOVE, 0, 0, 0, 0n); await Bun.sleep(60)
  for (let n = 0; n < count; n++) { user32.mouse_event(LEFT_DOWN, 0, 0, 0, 0n); await Bun.sleep(30); user32.mouse_event(LEFT_UP, 0, 0, 0, 0n); await Bun.sleep(60) }
}
/**
 * Press at the first point, move through the rest (`steps` moves between each pair), release at the last. `held` runs
 * with the button still down, after the last move.
 */
export async function drag(window: ReturnType<typeof windowOf>, points: (readonly [number, number])[], steps = 6, held?: () => Promise<void>) {
  const [first, ...rest] = points
  const [sx, sy] = window.screen(...first!)
  user32.SetCursorPos(sx, sy); user32.mouse_event(MOVE, 0, 0, 0, 0n); await Bun.sleep(80)
  user32.mouse_event(LEFT_DOWN, 0, 0, 0, 0n); await Bun.sleep(60)
  let from = first!
  for (const to of rest) {
    for (let n = 1; n <= steps; n++) {
      const [x, y] = window.screen(from[0] + (to[0] - from[0]) * n / steps, from[1] + (to[1] - from[1]) * n / steps)
      user32.SetCursorPos(x, y); user32.mouse_event(MOVE, 0, 0, 0, 0n); await Bun.sleep(25)
    }
    from = to
  }
  await Bun.sleep(60)
  await held?.()
  user32.mouse_event(LEFT_UP, 0, 0, 0, 0n); await Bun.sleep(120)
}
/** A click with keys held (`VK_MENU` 0x12 for ⌥-click). */
export async function clickWith(window: ReturnType<typeof windowOf>, x: number, y: number, modifiers: number[]) {
  for (const m of modifiers) user32.keybd_event(m, 0, 0, 0n)
  await Bun.sleep(40)
  await click(window, x, y)
  for (const m of [...modifiers].reverse()) user32.keybd_event(m, 0, KEY_UP, 0n)
  await Bun.sleep(150)
}
/**
 * Press at one window point, move in steps to another and release, in screen pixels fixed at the start: a real drag that
 * moves the window itself (Windows' caption takes it over), so the points must not follow the window as `drag` does.
 */
export async function dragWindow(window: ReturnType<typeof windowOf>, from: readonly [number, number], to: readonly [number, number], steps = 12) {
  const [sx, sy] = window.screen(from[0], from[1]), [ex, ey] = window.screen(to[0], to[1])
  user32.SetCursorPos(sx, sy); user32.mouse_event(MOVE, 0, 0, 0, 0n); await Bun.sleep(80)
  user32.mouse_event(LEFT_DOWN, 0, 0, 0, 0n); await Bun.sleep(80)
  for (let n = 1; n <= steps; n++) {
    user32.SetCursorPos(Math.round(sx + ((ex - sx) * n) / steps), Math.round(sy + ((ey - sy) * n) / steps)); user32.mouse_event(MOVE, 0, 0, 0, 0n); await Bun.sleep(30)
  }
  await Bun.sleep(80); user32.mouse_event(LEFT_UP, 0, 0, 0, 0n); await Bun.sleep(200)
}

/** The process's largest visible top-level window (its GPUI window), or 0. */
export function findWindow(pid: number): number {
  let best = 0, area = 0
  const owner = new Uint32Array(1), rect = new Int32Array(4)
  const callback = new JSCallback((hwnd: bigint) => {
    user32.GetWindowThreadProcessId(hwnd, ptr(owner))
    if (owner[0] === pid && user32.IsWindowVisible(hwnd)) {
      user32.GetWindowRect(hwnd, ptr(rect))
      const size = (rect[2]! - rect[0]!) * (rect[3]! - rect[1]!)
      if (size > area) { area = size; best = Number(hwnd) }
    }
    return 1
  }, { args: [FFIType.u64, FFIType.i64], returns: FFIType.i32 })
  try { user32.EnumWindows(callback.ptr, 0n) } finally { callback.close() }
  return best
}

/** Maximized, minimized and the outer frame in screen pixels; `exists` false once the window is destroyed. */
export function windowState(hwnd: number) {
  const rect = new Int32Array(4)
  user32.GetWindowRect(BigInt(hwnd), ptr(rect))
  return { exists: !!user32.IsWindow(BigInt(hwnd)), maximized: !!user32.IsZoomed(BigInt(hwnd)), minimized: !!user32.IsIconic(BigInt(hwnd)), x: rect[0]!, y: rect[1]!, width: rect[2]! - rect[0]!, height: rect[3]! - rect[1]! }
}

const HIT: Record<number, string> = { 0: 'nowhere', 1: 'client', 2: 'caption', 8: 'minimize', 9: 'maximize', 12: 'top', 13: 'top-left', 14: 'top-right', 20: 'close' }
/** What the window answers `WM_NCHITTEST` with at a window point (`caption`, `maximize`, `client`, …). GPUI answers from
 *  the hitboxes under the pointer as of its last mouse move, so move there first. */
export function hitTest(window: ReturnType<typeof windowOf>, x: number, y: number): string {
  const [sx, sy] = window.screen(x, y)
  const code = Number(user32.SendMessageW(BigInt(window.hwnd), 0x84, 0n, BigInt(((sy & 0xffff) << 16) | (sx & 0xffff))))
  return HIT[code] ?? String(code)
}

/** `ShowWindow(SW_RESTORE)`: bring a minimized window back. */
export const restoreWindow = (hwnd: number) => user32.ShowWindow(BigInt(hwnd), 9)

export async function move(window: ReturnType<typeof windowOf>, x: number, y: number) {
  const [sx, sy] = window.screen(x, y)
  user32.SetCursorPos(sx, sy); user32.mouse_event(MOVE, 0, 0, 0, 0n); await Bun.sleep(80)
}
export async function wheel(window: ReturnType<typeof windowOf>, x: number, y: number, delta: number) {
  await move(window, x, y); user32.mouse_event(WHEEL, 0, 0, delta, 0n); await Bun.sleep(120)
}
/** Virtual keys: VK_ESCAPE 0x1b, VK_CONTROL 0x11, '0'–'9' 0x30–0x39, 'A'–'Z' 0x41–0x5a. */
export async function key(vk: number, modifiers: number[] = []) {
  for (const m of modifiers) user32.keybd_event(m, 0, 0, 0n)
  user32.keybd_event(vk, 0, 0, 0n); await Bun.sleep(20); user32.keybd_event(vk, 0, KEY_UP, 0n)
  for (const m of [...modifiers].reverse()) user32.keybd_event(m, 0, KEY_UP, 0n)
  await Bun.sleep(150)
}

export interface Capture { width: number; height: number; at: (x: number, y: number) => [number, number, number]; file: string }

/**
 * The window's client area as composed by DWM (GPUI's swap chain and the WebView2 visuals above it), written to `file`
 * as a PNG. `screen` copies the desktop (what the user sees; the window must be in front), `print` asks DWM for the
 * window alone (`PrintWindow` with `PW_RENDERFULLCONTENT`). Pixels are read back in window points.
 */
export function capture(window: ReturnType<typeof windowOf>, file: string, how: 'screen' | 'print' = 'print'): Capture {
  const c = window.client(), { width, height } = c
  const screenDc = user32.GetDC(0n), memory = gdi32.CreateCompatibleDC(screenDc), bitmap = gdi32.CreateCompatibleBitmap(screenDc, width, height)
  const old = gdi32.SelectObject(memory, bitmap)
  const ok = how === 'print' ? user32.PrintWindow(BigInt(window.hwnd), memory, 1 | 2) : gdi32.BitBlt(memory, 0, 0, width, height, screenDc, c.x, c.y, 0x00CC0020 | 0x40000000)
  gdi32.SelectObject(memory, old)
  const info = new Int32Array(10)
  info[0] = 40; info[1] = width; info[2] = -height; new Int16Array(info.buffer, 12, 2).set([1, 32])
  const bgra = new Uint8Array(width * height * 4)
  gdi32.GetDIBits(memory, bitmap, 0, height, ptr(bgra), ptr(info), 0)
  gdi32.DeleteObject(bitmap); gdi32.DeleteDC(memory); user32.ReleaseDC(0n, screenDc)
  if (!ok) throw new Error(`${how} capture failed`)
  writePng(file, width, height, bgra)
  const at = (x: number, y: number): [number, number, number] => {
    const px = Math.min(width - 1, Math.max(0, Math.round(x * window.scale))), py = Math.min(height - 1, Math.max(0, Math.round(y * window.scale)))
    const i = (py * width + px) * 4
    return [bgra[i + 2]!, bgra[i + 1]!, bgra[i]!]
  }
  return { width, height, at, file }
}

const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
function crc32(bytes: Uint8Array) { let c = 0xffffffff; for (const b of bytes) c = CRC[(c ^ b) & 255]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
function chunk(kind: string, data: Uint8Array) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0); out.write(kind, 4, 'ascii'); Buffer.from(data).copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}
/** An opaque RGB PNG from top-down BGRA rows. */
export function writePng(file: string, width: number, height: number, bgra: Uint8Array) {
  const raw = Buffer.alloc(height * (width * 3 + 1))
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4, o = y * (width * 3 + 1) + 1 + x * 3
    raw[o] = bgra[i + 2]!; raw[o + 1] = bgra[i + 1]!; raw[o + 2] = bgra[i]!
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2
  writeFileSync(file, Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'binary'), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())]))
}
