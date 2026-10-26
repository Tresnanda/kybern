// ⌃1–⌃8 pick spaces 1–8 and ⌃9 the last one (the browser-tab convention). Only with two or more
// spaces, and never while a terminal has focus: ⌃3–⌃8 are control bytes for its PTY. macOS's
// optional Mission Control shortcuts ("Switch to Desktop N") take ⌃digits before the app.
// Off macOS Ctrl+1–9 pick tabs (⌘1–⌘9 on macOS), so spaces take Alt+1–9 (`SHORTCUT.space`).
import type { EventPayload } from '@gpuix/react'
import { addWindowKeyHandler } from '../nav/keys.ts'
import { isSpaceModifier } from '../platform/keys.ts'
import { terminalHasFocus } from '../terminal/focus.ts'
import { activateSpace } from './current.ts'
import { getSpaces } from './store.ts'

/** Which space ⌃`digit` picks: 1–8 by position, 9 the last. Flip `LAST_ON_NINE` to make ⌃9 an ordinary ninth space. */
const LAST_ON_NINE = true

export function spaceForDigit(digit: number, count: number): number | null {
  if (digit < 1 || digit > 9) return null
  const index = LAST_ON_NINE && digit === 9 ? count - 1 : digit - 1
  return index < count ? index : null
}

export function spaceKey(event: EventPayload): boolean {
  const m = event.modifiers
  if (!isSpaceModifier(m) || event.isHeld) return false
  if (!event.key || !/^[1-9]$/.test(event.key)) return false
  const { supported, spaces } = getSpaces()
  if (supported !== true || spaces.length < 2 || terminalHasFocus()) return false
  const index = spaceForDigit(Number(event.key), spaces.length)
  if (index === null) return false
  activateSpace(spaces[index]!.id, 'keyboard')
  return true
}

/** Register the shortcuts. Called once by the app shell. */
export const startSpaceKeys = () => addWindowKeyHandler(spaceKey)
