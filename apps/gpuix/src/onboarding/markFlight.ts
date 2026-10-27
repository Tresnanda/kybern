// Where the Kybern mark is on screen in the hero and in the agents hub, so one floating copy can fly between them (SPEC §3e).
import type { LayoutRect } from '../native/layout.ts'
import { createStore } from './store.ts'

export const markRects: { hero: LayoutRect | null; hub: LayoutRect | null } = { hero: null, hub: null }
/** `flying`: the floating copy is in the air and the hub's own mark waits. */
export const flight = createStore<{ flying: boolean }>({ flying: false })
