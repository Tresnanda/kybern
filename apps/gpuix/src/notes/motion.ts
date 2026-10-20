// Notes motion (P4.1-P4.6): every entrance and exit is a `paintTransform` (paint-only: no layout, render or island work per
// frame). Values are the desktop's (`notes.css`): the document rises in 200 ms from 6 px, a banner in 180 ms from 4 px, a gallery
// card in 170 ms from 6 px staggered 25 ms (no blur: many cards), a note card lifts 2 px on hover over 140 ms.
import type { PaintTransformProps } from '@gpuix/native/host'
import { useMemo, useRef, useState } from 'react'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { isWindowVisible } from '../native/visibility.ts'
import { BLUR, DURATION, EASE } from '../motion/tokens.ts'
import { REDUCED_MOTION } from '../ui.tsx'
import type { NoteSummary } from '../../../../packages/kybern-client/src/types.ts'

const bezier = (ease: readonly [number, number, number, number]) => [...ease] as [number, number, number, number]
const REDUCED_FADE: PaintTransformProps = { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: DURATION.quick, ease: bezier(EASE.smoothOut) } }

/** Opacity 0 and `distance` px low (plus `blur`) → rest over `duration` s (`--ease-smooth-out`); Reduce Motion fades 150 ms; `undefined` with the stock addon. */
function riseIn(distance: number, duration: number, blur = 0, delay = 0): PaintTransformProps | undefined {
  if (!PATCHED_NATIVE) return undefined
  if (REDUCED_MOTION) return REDUCED_FADE
  return {
    initial: { opacity: 0, translateY: distance, ...(blur ? { blur } : {}) },
    animate: { opacity: 1, translateY: 0, ...(blur ? { blur: 0 } : {}) },
    transition: { duration, delay, ease: bezier(EASE.smoothOut) },
  }
}

/** `note-doc-in` (notes.css:784): the open document, 200 ms from 6 px with a 2 px blur. */
export const noteDocIn = () => riseIn(6, 0.2, BLUR.small)
/** `note-banner-in`: a banner that appears above an open document, 180 ms from 4 px. */
export const noteBannerIn = () => riseIn(4, 0.18)
/** A gallery card's entrance: 170 ms from 6 px, 25 ms apart for the first four (no blur: many cards at once). */
export const cardIn = (index: number) => riseIn(6, 0.17, 0, Math.min(index, 3) * 0.025)

/** `.note-thumb` hover lift: `translateY(-2px)` over 140 ms on `--n-ease` (the pressed settle uses the same curve). */
export const NOTE_LIFT_MS = Number(process.env.KYBERN_NOTE_LIFT_MS) || 140
export const NOTE_LIFT_PX = 2
/** `--n-ease` (notes.css:36). */
export const NOTE_EASE: [number, number, number, number] = [0.2, 0, 0, 1]
/**
 * The thumbnail's paint scope (one for the lift and the press squash, `scale(0.985)` while a primary press is held). It exists only while
 * the card is hot (hovered or pressed) and for the return tween after: a scope that rests at identity is untagged, so its first change
 * renders the window once (an extra present between wheel frames while cards move under the pointer), and tagging a few hundred resting
 * scopes (`retain`) costs a second retained present on every scroll frame (measured). Mounting the scope in the hover's own commit has
 * neither. Reduce Motion: no transform.
 */
export function thumbLift(lifted: boolean, pressed = false): PaintTransformProps | undefined {
  if (!PATCHED_NATIVE || REDUCED_MOTION) return undefined
  return { initial: { translateY: 0, scale: 1 }, animate: { translateY: lifted && !pressed ? -NOTE_LIFT_PX : 0, scale: pressed ? 0.985 : 1 }, transition: { duration: NOTE_LIFT_MS / 1000, ease: NOTE_EASE } }
}

// ─── Deleting a note: the card leaves by pointer, instantly by keyboard ───────────────────────────────────────────────

const marked = new Map<string, { note: NoteSummary; until: number }>()
/** A pointer delete (menu) marks its note (as it was, so the card fades where it stood) for the gallery; the keyboard path never marks. */
export function markNoteLeaving(note: NoteSummary) {
  marked.set(note.id, { note, until: Date.now() + 3000 })
}
function takeMark(id: string): NoteSummary | null {
  const entry = marked.get(id)
  marked.delete(id)
  return entry && entry.until > Date.now() ? entry.note : null
}
function freshMarks(): NoteSummary[] {
  const now = Date.now(), out: NoteSummary[] = []
  for (const [id, entry] of marked) { marked.delete(id); if (entry.until > now) out.push(entry.note) }
  return out
}

/** `EXIT.row`-like card exit: the card fades and settles to 0.97 over 150 ms. */
export function cardLeave(generation: number): PaintTransformProps | undefined {
  if (!PATCHED_NATIVE) return undefined
  return {
    // From where the card stands (a ghost mounts already leaving, so `initial: false` would start it at the end).
    initial: REDUCED_MOTION ? { opacity: 1 } : { opacity: 1, scale: 1 },
    animate: REDUCED_MOTION ? { opacity: 0 } : { opacity: 0, scale: 0.97 },
    transition: { duration: REDUCED_MOTION ? 0.1 : DURATION.quick, ease: bezier(EASE.smoothOut) },
    generation,
  }
}

let ghostGeneration = 6_100_000
/**
 * The notes to draw: `visible` plus the notes a pointer delete just removed, kept for their 150 ms exit. A delete from the
 * editor's menu lands on a gallery that never had the card, so a mark that is still fresh when the gallery mounts keeps that
 * note's card (as it was when it was deleted) fading out as the page arrives. `gone(id)` (called when a card's exit completes)
 * drops them. Filters, searches, sorts and keyboard deletes never keep anything.
 */
export function useLeavingNotes(visible: NoteSummary[]) {
  const [ghosts, setGhosts] = useState<{ note: NoteSummary; generation: number }[]>(() => {
    if (!PATCHED_NATIVE || !isWindowVisible()) return []
    return freshMarks().filter(note => !visible.some(v => v.id === note.id)).map(note => ({ note, generation: ++ghostGeneration }))
  })
  const previous = useRef(visible)
  if (previous.current !== visible) {
    const before = previous.current
    previous.current = visible
    const canLeave = PATCHED_NATIVE && isWindowVisible()
    const removed = before.filter(note => !visible.some(v => v.id === note.id)).flatMap(note => takeMark(note.id) ?? [])
    if (canLeave && removed.length) setGhosts(current => [...current.filter(g => !visible.some(v => v.id === g.note.id)), ...removed.map(note => ({ note, generation: ++ghostGeneration }))])
    else if (ghosts.some(g => visible.some(v => v.id === g.note.id))) setGhosts(current => current.filter(g => !visible.some(v => v.id === g.note.id)))
  }
  const gone = (id: string) => setGhosts(current => current.filter(g => g.note.id !== id))
  const list = useMemo(() => (ghosts.length ? [...visible, ...ghosts.map(g => g.note)] : visible), [visible, ghosts])
  const leaving = useMemo(() => new Map(ghosts.map(g => [g.note.id, g.generation])), [ghosts])
  return { list, leaving, gone }
}

/**
 * Ids that appeared in the gallery since its last render while nothing that reshapes it changed (`context`: filter, search, layout,
 * grouping, sort, columns, loaded): a restored or newly created note. They enter like fresh content; filter changes and typing never do.
 */
export function useFreshNotes(visible: NoteSummary[], context: string): ReadonlySet<string> {
  const ledger = useRef<{ context: string; ids: Set<string> }>({ context, ids: new Set(visible.map(n => n.id)) })
  const fresh = new Set<string>()
  if (ledger.current.context === context) for (const note of visible) if (!ledger.current.ids.has(note.id)) fresh.add(note.id)
  ledger.current = { context, ids: new Set(visible.map(n => n.id)) }
  return fresh.size > 12 ? new Set() : fresh
}
