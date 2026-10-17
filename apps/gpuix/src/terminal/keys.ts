import type { EventPayload } from '@gpuix/react'
export function terminalKey(event: Pick<EventPayload, 'key' | 'keyChar' | 'modifiers'>, application = false): string | null {
  const key = event.key ?? '', m = event.modifiers
  if (m?.cmd) return null
  const alt = m?.alt ? '\x1b' : ''
  if (m?.ctrl) {
    const controls: Record<string, string> = { space: '\0', ' ': '\0', '2': '\0', '3': '\x1b', '4': '\x1c', '5': '\x1d', '6': '\x1e', '7': '\x1f', '8': '\x7f', '/': '\x1f', '?': '\x7f' }
    if (controls[key] !== undefined) return alt + controls[key]
    if (key.length === 1) { const code = key.toUpperCase().charCodeAt(0); if (code >= 64 && code <= 95) return alt + String.fromCharCode(code - 64) }
  }
  const modifier = 1 + (m?.shift ? 1 : 0) + (m?.alt ? 2 : 0) + (m?.ctrl ? 4 : 0)
  const arrows: Record<string, string> = { up: 'A', down: 'B', right: 'C', left: 'D', home: 'H', end: 'F' }
  let value: string | undefined
  if (arrows[key]) return modifier > 1 ? `\x1b[1;${modifier}${arrows[key]}` : `\x1b${application ? 'O' : '['}${arrows[key]}`
  const tilde: Record<string, number> = { insert: 2, delete: 3, pageup: 5, pagedown: 6, f5: 15, f6: 17, f7: 18, f8: 19, f9: 20, f10: 21, f11: 23, f12: 24 }
  if (tilde[key]) return `\x1b[${tilde[key]}${modifier > 1 ? `;${modifier}` : ''}~`
  const functionKey: Record<string, string> = { f1: 'P', f2: 'Q', f3: 'R', f4: 'S' }
  if (functionKey[key]) return modifier > 1 ? `\x1b[1;${modifier}${functionKey[key]}` : `\x1bO${functionKey[key]}`
  const keys: Record<string, string> = { enter: '\r', return: '\r', backspace: '\x7f', delete: '\x1b[3~', escape: '\x1b', tab: m?.shift ? '\x1b[Z' : '\t', space: ' ', pageup: '\x1b[5~', pagedown: '\x1b[6~', insert: '\x1b[2~', f1: '\x1bOP', f2: '\x1bOQ', f3: '\x1bOR', f4: '\x1bOS', f5: '\x1b[15~', f6: '\x1b[17~', f7: '\x1b[18~', f8: '\x1b[19~', f9: '\x1b[20~', f10: '\x1b[21~', f11: '\x1b[23~', f12: '\x1b[24~' }
  value = keys[key] ?? event.keyChar ?? (key.length === 1 ? (m?.shift ? key.toUpperCase() : key) : undefined)
  return value === undefined ? null : alt + value
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
