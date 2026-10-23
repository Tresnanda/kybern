// The state of the one pick card on screen, keyed by approval id (module state, like `requests/ui.ts`: the card remounts when
// the stack re-renders, and a pick in the page outlives it).
import { useSyncExternalStore } from 'react'
import type { ElementPayload, ElementShot } from './hub.ts'

export interface PickUi {
  /** ask: rows; picking: the page is waiting for a click; capturing: the crop is being made; confirm: send this element?;
   *  sending: the answer is on its way. */
  phase: 'ask' | 'picking' | 'capturing' | 'confirm' | 'sending'
  error: string
  highlight: number
  picked: { payload: ElementPayload; shot: ElementShot | null } | null
}

const IDLE: PickUi = { phase: 'ask', error: '', highlight: 0, picked: null }
const cards = new Map<string, PickUi>()
const listeners = new Set<() => void>()

export const getPickUi = (id: string): PickUi => cards.get(id) ?? IDLE
export function patchPickUi(id: string, patch: Partial<PickUi>) {
  cards.set(id, { ...getPickUi(id), ...patch })
  for (const listener of listeners) listener()
}
export function forgetPickUi(id: string) { if (cards.delete(id)) for (const listener of listeners) listener() }
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
export const usePickUi = (id: string): PickUi => useSyncExternalStore(subscribe, () => getPickUi(id))
