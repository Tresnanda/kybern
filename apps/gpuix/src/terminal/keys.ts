import type { EventPayload } from '@gpuix/react'
const KEY_MODIFIERS = (m: { shift?: boolean; alt?: boolean; ctrl?: boolean; cmd?: boolean } | undefined) => (m?.shift ? 1 : 0) | (m?.alt ? 2 : 0) | (m?.ctrl ? 4 : 0) | (m?.cmd ? 8 : 0)
/** Keys whose Shift+PageUp/PageDown scroll the viewport instead of reaching the program, and Cmd+A. */
export function terminalViewportKey(event: Pick<EventPayload, 'key' | 'modifiers'>): 'pageup' | 'pagedown' | 'selectall' | null {
  const key = event.key ?? '', m = event.modifiers
  if ((key === 'pageup' || key === 'pagedown') && m?.shift) return key
  if (key === 'a' && m?.cmd && !m.alt && !m.ctrl && !m.shift) return 'selectall'
  return null
}
/**
 * The bytes xterm.js 6.0.0 sends for a key press on macOS (src/common/input/Keyboard.ts with
 * macOptionIsMeta off): Option composes characters, so Option+letter sends the composed text.
 * Null means nothing is sent from the key itself.
 */
export function terminalKey(event: Pick<EventPayload, 'key' | 'keyChar' | 'modifiers'>, application = false): string | null {
  const key = event.key ?? '', m = event.modifiers
  const modifiers = KEY_MODIFIERS(m), mod = modifiers + 1
  const ESC = '\x1b'
  if (m?.cmd) return null
  const cursor = (final: string) => modifiers ? `${ESC}[1;${mod}${final}` : `${ESC}${application ? 'O' : '['}${final}`
  const tilde = (code: number) => modifiers ? `${ESC}[${code};${mod}~` : `${ESC}[${code}~`
  switch (key) {
    case 'backspace': return (m?.alt ? ESC : '') + (m?.ctrl ? '\b' : '\x7f')
    case 'tab': return m?.shift ? `${ESC}[Z` : '\t'
    case 'enter': case 'return': return m?.alt ? `${ESC}\r` : '\r'
    case 'escape': return m?.alt ? `${ESC}${ESC}` : ESC
    case 'left': return cursor('D')
    case 'right': return cursor('C')
    case 'up': return cursor('A')
    case 'down': return cursor('B')
    case 'home': return modifiers ? `${ESC}[1;${mod}H` : application ? `${ESC}OH` : `${ESC}[H`
    case 'end': return modifiers ? `${ESC}[1;${mod}F` : application ? `${ESC}OF` : `${ESC}[F`
    case 'insert': return !m?.shift && !m?.ctrl ? `${ESC}[2~` : null
    case 'delete': return tilde(3)
    case 'pageup': return m?.shift ? null : m?.ctrl ? `${ESC}[5;${mod}~` : `${ESC}[5~`
    case 'pagedown': return m?.shift ? null : m?.ctrl ? `${ESC}[6;${mod}~` : `${ESC}[6~`
    case 'f1': return modifiers ? `${ESC}[1;${mod}P` : `${ESC}OP`
    case 'f2': return modifiers ? `${ESC}[1;${mod}Q` : `${ESC}OQ`
    case 'f3': return modifiers ? `${ESC}[1;${mod}R` : `${ESC}OR`
    case 'f4': return modifiers ? `${ESC}[1;${mod}S` : `${ESC}OS`
    case 'f5': return tilde(15)
    case 'f6': return tilde(17)
    case 'f7': return tilde(18)
    case 'f8': return tilde(19)
    case 'f9': return tilde(20)
    case 'f10': return tilde(21)
    case 'f11': return tilde(23)
    case 'f12': return tilde(24)
  }
  if (m?.ctrl && !m.shift && !m.alt) {
    if (key.length === 1 && key >= 'a' && key <= 'z') return String.fromCharCode(key.charCodeAt(0) - 96)
    if (key === 'space' || key === ' ') return '\0'
    if (key >= '3' && key <= '7') return String.fromCharCode(key.charCodeAt(0) - 51 + 27)
    if (key === '8') return '\x7f'
    if (key === '[') return ESC
    if (key === '\\') return '\x1c'
    if (key === ']') return '\x1d'
  }
  if (m?.ctrl) {
    const char = event.keyChar ?? key
    if (char === '_') return '\x1f'
    if (char === '@') return '\0'
    return null
  }
  if (m?.alt) return event.keyChar && event.keyChar.length <= 2 && event.keyChar !== key ? event.keyChar : key === 'space' ? ' ' : null
  if (key === 'space') return ' '
  return event.keyChar ?? (key.length === 1 ? (m?.shift ? key.toUpperCase() : key) : null)
}

export interface MouseModes { mouseTracking: number; mouseSgr: boolean; mousePixels?: boolean }
export interface TerminalMouseEvent { kind: 'down' | 'up' | 'move' | 'wheel'; column: number; row: number; /** Pixel position inside the screen, for SGR-Pixels (DECSET 1016). */ px?: number; py?: number; button?: number; deltaY?: number; modifiers?: { shift?: boolean; alt?: boolean; ctrl?: boolean; cmd?: boolean } }
/**
 * xterm.js CoreMouseService: protocols X10 (9), VT200 (1000), drag (1002) and any-motion (1003) with the
 * default (single byte, up to 223) or SGR encodings. UTF-8 and urxvt encodings are not supported there either.
 * Shift is Kybern's override to select text in the scrollback instead of reporting (xterm.js has none on macOS).
 */
export function terminalMouse(event: TerminalMouseEvent, modes: MouseModes): string | null {
  const { kind, modifiers: m } = event, mode = modes.mouseTracking
  if (!mode || m?.shift || m?.cmd || event.column < 0 || event.row < 0) return null
  if (kind === 'move' && mode !== 1003 && !(mode === 1002 && event.button !== undefined)) return null
  if ((mode === 9 || mode === 1000) && kind === 'move') return null
  if (mode === 9 && kind !== 'down') return null
  if (kind === 'wheel' && !event.deltaY) return null
  const button = kind === 'wheel' ? (event.deltaY! > 0 ? 64 : 65) : (event.button ?? 3)
  if (button < 0 || (button > 2 && kind !== 'wheel' && kind !== 'move')) return null
  const modifier = mode === 9 ? 0 : (m?.alt ? 8 : 0) + (m?.ctrl ? 16 : 0)
  const code = (kind === 'up' && !modes.mouseSgr ? 3 : button) + (kind === 'move' ? 32 : 0) + modifier
  const x = Math.floor(modes.mousePixels && event.px !== undefined ? event.px : event.column) + 1, y = Math.floor(modes.mousePixels && event.py !== undefined ? event.py : event.row) + 1
  if (modes.mouseSgr) return `\x1b[<${code};${x};${y}${kind === 'up' ? 'm' : 'M'}`
  // The default encoding cannot address cells past 223; xterm.js sends nothing then.
  if (code + 32 > 255 || x + 32 > 255 || y + 32 > 255) return null
  return `\x1b[M${String.fromCharCode(code + 32, x + 32, y + 32)}`
}

/** Bracket delimiters are terminal protocol, never part of the pasted text. */
export function terminalPaste(text: string, bracketed: boolean): string {
  return bracketed ? `\x1b[200~${text.replaceAll('\x1b', '')}\x1b[201~` : text
}
