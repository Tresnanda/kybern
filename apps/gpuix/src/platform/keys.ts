// The platform's shortcut modifier and how shortcut labels read (WP3). GPUIX reports ⌘ as `cmd` on macOS; off macOS
// `cmd` is GPUI's `platform` modifier, the Windows / Super key, so shortcuts test `isPrimary` instead: ⌘ on macOS, Ctrl
// elsewhere. Alt is ⌥ on macOS; Windows sends AltGr as Ctrl+Alt, which no Alt-only check matches.
//
// Callers keep writing labels in macOS glyphs (`⌘⇧S`, `['⌘', 'N']`); `Kbd`, `Tip`, `MenuItem` and the kit `Button`
// convert them, so off macOS they read `Ctrl+Shift+S` and `Ctrl` `N`. Where the shortcut itself differs off macOS
// (back and forward, open parent, spaces, the terminal's copy and paste), `SHORTCUT` holds the right one per platform.

export type KeyMods = { cmd?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean } | null | undefined

let platform: NodeJS.Platform = process.platform

/** Tests only: read shortcuts as on `next`. Returns the restore. */
export function setKeyPlatform(next: NodeJS.Platform): () => void {
  const before = platform
  platform = next
  return () => { platform = before }
}

/** The platform shortcuts follow (`process.platform` unless a test set another). */
export const keyPlatform = () => platform

/** Whether shortcuts follow macOS (⌘ primary, glyph labels). */
export const isMacKeys = () => platform === 'darwin'

/** The shortcut modifier: ⌘ on macOS, Ctrl elsewhere. */
export const isPrimary = (m: KeyMods) => !!(isMacKeys() ? m?.cmd : m?.ctrl)

/** The other command-like modifier, which primary chords exclude: ⌃ on macOS, the Windows / Super key elsewhere. */
export const isOtherCommand = (m: KeyMods) => !!(isMacKeys() ? m?.ctrl : m?.cmd)

type Want = boolean | 'any'
const wanted = (held: boolean | undefined, want: Want) => want === 'any' || !!held === want

/** Primary held, the other command key not, and Shift and Alt exactly as given (default: not held). */
export function isPrimaryChord(m: KeyMods, want: { shift?: Want; alt?: Want } = {}): boolean {
  return isPrimary(m) && !isOtherCommand(m) && wanted(m?.alt, want.alt ?? false) && wanted(m?.shift, want.shift ?? false)
}

/** ⌃ as the Emacs list and caret key (⌃N ⌃P in menus): macOS only; elsewhere Ctrl is the shortcut key (Ctrl+N new thread). */
export const isEmacsCtrl = (m: KeyMods) => isMacKeys() && !!m?.ctrl

/** Alt (⌥) alone: no Ctrl, ⌘ / Windows key or Shift. */
export const isAltOnly = (m: KeyMods) => !!m?.alt && !m.ctrl && !m.cmd && !m.shift

type KeyEvent = { key?: string; modifiers?: KeyMods }

/** Back: ⌘[ on macOS; Alt+← elsewhere (the browser's; Ctrl+[ is Escape in a terminal). */
export const isBackKey = (e: KeyEvent) => isMacKeys() ? isPrimaryChord(e.modifiers) && e.key === '[' : isAltOnly(e.modifiers) && e.key === 'left'
/** Forward: ⌘] on macOS; Alt+→ elsewhere. */
export const isForwardKey = (e: KeyEvent) => isMacKeys() ? isPrimaryChord(e.modifiers) && e.key === ']' : isAltOnly(e.modifiers) && e.key === 'right'
/** A subagent's parent: ⌘↑ on macOS; Alt+↑ elsewhere (Explorer's "up one level"; Ctrl+↑ moves the caret or scrolls). */
export const isOpenParentKey = (e: KeyEvent) => isMacKeys() ? isPrimaryChord(e.modifiers) && e.key === 'up' : isAltOnly(e.modifiers) && e.key === 'up'
/** The space shortcut modifier: ⌃ on macOS; Alt elsewhere, because Ctrl+1–9 picks tabs there. */
export const isSpaceModifier = (m: KeyMods) => isMacKeys() ? !!m?.ctrl && !m.cmd && !m.alt && !m.shift : isAltOnly(m)

/** Shortcuts that differ by platform, in macOS glyphs (labels convert them). */
export const SHORTCUT = {
  get back() { return isMacKeys() ? '⌘[' : '⌥←' },
  get forward() { return isMacKeys() ? '⌘]' : '⌥→' },
  get openParent() { return isMacKeys() ? '⌘↑' : '⌥↑' },
  /** The space modifier glyph; the digit follows. */
  get space() { return isMacKeys() ? '⌃' : '⌥' },
  // A focused terminal: Ctrl+C/V/F reach the shell off macOS, so the app's own take Shift (Windows Terminal, GNOME Terminal).
  get terminalCopy() { return isMacKeys() ? '⌘C' : '⌃⇧C' },
  get terminalPaste() { return isMacKeys() ? '⌘V' : '⌃⇧V' },
  get terminalFind() { return isMacKeys() ? '⌘F' : '⌃⇧F' },
  get terminalLatest() { return isMacKeys() ? '⌘End' : '⌃⇧End' },
}

// ---- labels ----

const MODIFIERS: Record<string, string> = { '⌃': 'Ctrl', '⌘': 'Ctrl', '⌥': 'Alt', '⇧': 'Shift' }
/** Windows order: Ctrl, Alt, Shift. */
const ORDER = ['Ctrl', 'Alt', 'Shift']
const KEYS: Record<string, string> = { '↵': 'Enter', '↩': 'Enter', '⌫': 'Backspace', '⌦': 'Delete', '⇥': 'Tab', '⎋': 'Esc' }
const NAMED = /^(End|Home|Enter|Return|Tab|Space|Esc|Escape|Delete|Backspace|PageUp|PageDown|Up|Down|Left|Right)\b/
const isModifier = (c: string) => c in MODIFIERS

/** Split a glyph shortcut into its caps: `⌘⇧S` → `['⌘', '⇧', 'S']`, `⌘End` → `['⌘', 'End']`, `⌥-click` → `['⌥', '-click']`. */
export function shortcutCaps(shortcut: string): string[] {
  const caps: string[] = []
  let rest = shortcut
  while (rest && isModifier(rest[0]!)) { caps.push(rest[0]!); rest = rest.slice(rest[1] === '+' ? 2 : 1) }
  if (rest) caps.push(rest)
  return caps
}

/** Key caps for `Kbd`: unchanged on macOS; elsewhere `['⌘', 'N']` → `['Ctrl', 'N']`, modifiers in Ctrl, Alt, Shift order. */
export function keyCaps(keys: readonly string[]): string[] {
  if (isMacKeys()) return [...keys]
  const mods = new Set<string>(), rest: string[] = []
  for (const key of keys) {
    if (MODIFIERS[key]) mods.add(MODIFIERS[key])
    else rest.push(KEYS[key] ?? key)
  }
  return [...ORDER.filter(m => mods.has(m)), ...rest]
}

/** One modifier run and its key, off macOS: `⌘⇧S` → `Ctrl+Shift+S`, `⌥-click` → `Alt-click`. */
function chord(mods: string[], key: string): string {
  const names = ORDER.filter(m => mods.some(g => MODIFIERS[g] === m))
  if (!key || key.startsWith('-')) return names.join('+') + key
  return [...names, KEYS[key] ?? key].join('+')
}

/**
 * A shortcut label, or text with shortcuts in it, for this platform: unchanged on macOS; elsewhere `⌘⇧S` →
 * `Ctrl+Shift+S`, `⌘↵` → `Ctrl+Enter`, `⌃Tab` → `Ctrl+Tab`, `⌥-click` → `Alt-click`, `Toggle sidebar (⌘B)` →
 * `Toggle sidebar (Ctrl+B)`, `Send ↵` → `Send Enter`. Arrows stay arrows.
 */
export function shortcutLabel(text: string): string {
  if (isMacKeys()) return text
  let out = '', i = 0
  while (i < text.length) {
    const c = text[i]!
    if (!isModifier(c)) { out += KEYS[c] ?? c; i++; continue }
    const mods: string[] = []
    while (i < text.length && isModifier(text[i]!)) { mods.push(text[i]!); i += text[i + 1] === '+' ? 2 : 1 }
    const rest = text.slice(i)
    const named = NAMED.exec(rest)?.[0] ?? /^-[a-z]+/.exec(rest)?.[0]
    const key = named ?? (rest && !/^\s/.test(rest) ? [...rest][0]! : '')
    out += chord(mods, key)
    i += key.length
  }
  return out
}
