// The interaction state of the one card on screen: the highlighted row, whether the decline note is open, the choice in
// flight and its error. Module state, because digits and arrows also arrive from the composer (`Composer.tsx`), which is
// not a child of the card. Keyed by approval id; an answered card's entry goes with it (`forgetCardUi`).
import { useSyncExternalStore } from 'react'

export interface CardUi {
  highlight: number
  /** The decline note field is open. */
  note: boolean
  /** The row number being sent, or null. */
  sending: number | null
  error: string
  /** The clamped command, diff or plan shows in full. */
  expanded: boolean
}

const IDLE: CardUi = { highlight: 0, note: false, sending: null, error: '', expanded: false }
const cards = new Map<string, CardUi>()
const listeners = new Set<() => void>()

export const getCardUi = (id: string): CardUi => cards.get(id) ?? IDLE

export function patchCardUi(id: string, patch: Partial<CardUi>) {
  cards.set(id, { ...getCardUi(id), ...patch })
  for (const listener of listeners) listener()
}

export function forgetCardUi(id: string) {
  if (cards.delete(id)) for (const listener of listeners) listener()
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
export const useCardUi = (id: string): CardUi => useSyncExternalStore(subscribe, () => getCardUi(id))

/** Composers with text in them (by draft key): a card that arrives while someone is typing never takes focus. */
const typing = new Set<string>()
export function setComposerEmpty(draftKey: string, empty: boolean) { if (empty) typing.delete(draftKey); else typing.add(draftKey) }
export const someoneIsTyping = (): boolean => typing.size > 0

/** Moves keyboard focus to the card on screen (↑ ↓ in the empty composer). Set by the card's root while it is mounted. */
let focusRoot: (() => void) | null = null
export const registerCardFocus = (focus: (() => void) | null) => { focusRoot = focus }
export const focusCard = () => focusRoot?.()
