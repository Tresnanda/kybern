// Opening Settings at a section (#309): a link names a stable section id (`<Section id="compaction">`), not a position,
// because what sits above it comes and goes (the daemon's update row, OMP's project overrides, the Coordinator's tools). The id is held until that
// Section mounts in the page's list; its header then asks GPUIX to scroll it to the top (`scrollIntoView` resolves the
// header's item index in the list at that moment) and the section's card is tinted once, briefly.
import type { PublicInstance } from '@gpuix/react'
import { createContext, useEffect, useState, useSyncExternalStore, type RefObject } from 'react'
import { REDUCED_MOTION } from '../platform/reducedMotion.ts'
import { PATCHED_NATIVE } from '../native/local-build.ts'

/** Sections a link may open. Add an id here and on its `<Section>`. */
export type SettingsSectionId = 'compaction'

/** How long the landing tint stays up, its 0.2 s fade-in included; the fade-out adds 0.4 s. */
export const LANDING_HOLD_MS = 700

let target: SettingsSectionId | null = null
let landed: { section: SettingsSectionId; at: number } | null = null
const listeners = new Set<() => void>()
const notify = () => { for (const listener of listeners) listener() }
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }

/** The section the next Settings page should land on; `null` forgets a link that never landed. */
export function aimAt(section: SettingsSectionId | null) {
  if (target === section) return
  target = section
  notify()
}

export const pendingSection = () => target

/** The Settings page's list, for a landing section to know when GPUIX has built it. */
export const SettingsList = createContext<RefObject<PublicInstance | null> | null>(null)

type ListNative = { getListScrollTop?: (id: number) => number[] | null }

/**
 * Scroll `header` (a direct child of the list) to the top. GPUIX resolves the item from the list it built in the last
 * frame, so a list that just mounted drops the request: ask again each frame until the list reports that it moved, at
 * most half a second (a person scrolling meanwhile also counts as moved).
 */
export function revealHeader(renderer: object, list: RefObject<PublicInstance | null> | null, header: RefObject<PublicInstance | null>) {
  const native = renderer as ListNative
  let tries = 0
  const attempt = () => {
    const node = header.current
    const listId = list?.current?.id
    if (!node) return
    const top = listId != null ? native.getListScrollTop?.(listId) : null
    if (top && (top[0] !== 0 || top[1] !== 0)) return
    if (top || !native.getListScrollTop) node.scrollIntoView?.()
    if (++tries < 30) setTimeout(attempt, 16)
  }
  attempt()
}

/** The section's header mounted: scroll to it once, and tint it unless Reduce Motion is on. */
export function land(section: SettingsSectionId, scroll: () => void) {
  if (target !== section) return
  target = null
  scroll()
  if (!REDUCED_MOTION && PATCHED_NATIVE) landed = { section, at: Date.now() }
  notify()
}

/** Whether this section is being landed on (Settings → the link's target), and whether its tint is up. */
export function useLanding(section: SettingsSectionId | undefined) {
  const state = useSyncExternalStore(subscribe, () => (section && target === section ? 'aimed' : section && landed?.section === section ? landed.at : null))
  const [lit, setLit] = useState(false)
  useEffect(() => {
    if (typeof state !== 'number') return
    setLit(true)
    const timer = setTimeout(() => { setLit(false); if (landed?.at === state) landed = null }, LANDING_HOLD_MS)
    return () => clearTimeout(timer)
  }, [state])
  return { aimed: state === 'aimed', lit }
}
