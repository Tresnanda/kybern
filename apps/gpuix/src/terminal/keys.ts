import type { EventPayload } from '@gpuix/react'
export function terminalKey(event: Pick<EventPayload, 'key' | 'keyChar' | 'modifiers'>, application = false): string | null {
  const key = event.key ?? '', m = event.modifiers
  if (m?.cmd) return null
  if (m?.ctrl && key.length === 1) { const code = key.toUpperCase().charCodeAt(0); if (code >= 64 && code <= 95) return String.fromCharCode(code - 64); if (key === ' ' || key === '2') return '\0' }
  const arrows: Record<string, string> = { up: 'A', down: 'B', right: 'C', left: 'D', home: 'H', end: 'F' }
  let value: string | undefined
  if (arrows[key]) { const modifier = 1 + (m?.shift ? 1 : 0) + (m?.alt ? 2 : 0) + (m?.ctrl ? 4 : 0); return modifier > 1 ? `\x1b[1;${modifier}${arrows[key]}` : `\x1b${application ? 'O' : '['}${arrows[key]}` }
  const keys: Record<string, string> = { enter: '\r', return: '\r', backspace: '\x7f', delete: '\x1b[3~', escape: '\x1b', tab: m?.shift ? '\x1b[Z' : '\t', space: ' ', pageup: '\x1b[5~', pagedown: '\x1b[6~', insert: '\x1b[2~', f1: '\x1bOP', f2: '\x1bOQ', f3: '\x1bOR', f4: '\x1bOS', f5: '\x1b[15~', f6: '\x1b[17~', f7: '\x1b[18~', f8: '\x1b[19~', f9: '\x1b[20~', f10: '\x1b[21~', f11: '\x1b[23~', f12: '\x1b[24~' }
  value = keys[key] ?? event.keyChar ?? (key.length === 1 ? (m?.shift ? key.toUpperCase() : key) : undefined)
  return value === undefined ? null : (m?.alt ? '\x1b' : '') + value
}

/** Bracket delimiters are terminal protocol, never part of the pasted text. */
export function terminalPaste(text: string, bracketed: boolean): string {
  return bracketed ? `\x1b[200~${text.replaceAll('\x1b', '')}\x1b[201~` : text
}
