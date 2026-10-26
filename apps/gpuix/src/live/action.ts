// The caption wording of the desktop live view (views/ComputerLiveView.tsx `actionParts` and `keyGlyphs`).
import { isMacKeys, keyPlatform } from '../platform/keys.ts'

const KEY_GLYPHS: Record<string, string> = { cmd: '⌘', command: '⌘', shift: '⇧', option: '⌥', opt: '⌥', alt: '⌥', ctrl: '⌃', control: '⌃', return: '↩', enter: '↩', tab: '⇥', escape: 'esc', esc: 'esc', delete: '⌫', backspace: '⌫', space: 'Space', up: '↑', down: '↓', left: '←', right: '→' }
/** Off macOS the keys are named and joined with `+`; `cmd` is the literal Windows / Super key there, not Ctrl. */
const KEY_NAMES: Record<string, string> = { shift: 'Shift', option: 'Alt', opt: 'Alt', alt: 'Alt', ctrl: 'Ctrl', control: 'Ctrl', return: 'Enter', enter: 'Enter', tab: 'Tab', escape: 'Esc', esc: 'Esc', delete: 'Backspace', backspace: 'Backspace', space: 'Space', up: '↑', down: '↓', left: '←', right: '→' }
/** `cmd+shift+s` reads as `⌘⇧S`, the way macOS menus write shortcuts; elsewhere `ctrl+shift+s` reads `Ctrl+Shift+S`. */
export const keyGlyphs = (chord: string) => {
  if (!isMacKeys()) {
    const command = keyPlatform() === 'win32' ? 'Win' : 'Super'
    return chord.split('+').map(key => (/^(cmd|command|super|win|meta)$/i.test(key) ? command : KEY_NAMES[key.toLowerCase()]) ?? (key.length === 1 ? key.toUpperCase() : key)).join('+')
  }
  return chord.split('+').map(key => KEY_GLYPHS[key.toLowerCase()] ?? (key.length === 1 ? key.toUpperCase() : key)).join('')
}
export type ActionPart = { text: string; subject: boolean; keys?: boolean }
/** The daemon's step sentence as quiet wording around bright subjects: `Pressed “2”` becomes `Pressed` + `2`. */
export function actionParts(action: string): ActionPart[] {
  const pieces = action.split(/“([^”]*)”/)
  if (pieces.length > 1) return pieces.map((text, index) => ({ text: text.trim(), subject: index % 2 === 1 })).filter(part => part.text)
  const chord = /^Pressed (\S+)$/.exec(action)
  if (chord) return [{ text: 'Pressed', subject: false }, { text: keyGlyphs(chord[1]!), subject: true, keys: true }]
  return [{ text: action, subject: true }]
}
