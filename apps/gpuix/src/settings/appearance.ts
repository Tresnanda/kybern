import { environmentKey, onEnvironmentChange } from '../shell/environment.ts'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { useSyncExternalStore } from 'react'
import { getSystemVariant } from '../shell/appearance.ts'
import { snapshotBeforeThemeChange } from '../motion/themeFade.tsx'
import { BLUR_MAX, BLUR_MIN, OPACITY_MIN, isSidebarOnly, migrateWindow, normalizeVariantMaterial, type ThemeVariant, type VariantMaterial } from '../platform/translucency.ts'

export type Appearance = 'light' | 'dark' | 'system'
export interface AppearancePrefs { theme: Appearance; window: Record<ThemeVariant, VariantMaterial> }

const file = () => path.join(process.env.KYBERN_CLIENT_CONFIG_DIR ?? path.join(homedir(), 'Library/Application Support/kybern-gpuix'), `appearance-${createHash('sha1').update(environmentKey()).digest('hex').slice(0, 12)}.json`)

/**
 * The saved file in memory (§ "Migration"): `{ version: 3, theme, window: { dark, light } }`. Version 2 had one `opacity` and
 * `sidebarOnly`; the unversioned file only had `translucent`. Nothing is written back until the next `setAppearance` or `setWindowMaterial`, so a user who never
 * touches the setting keeps following the default.
 */
export function migrate(saved: unknown): AppearancePrefs {
  const theme = typeof saved === 'object' && saved !== null ? (saved as { theme?: unknown }).theme : undefined
  return { theme: theme === 'light' || theme === 'dark' || theme === 'system' ? theme : 'system', window: migrateWindow(saved) }
}

function load(): AppearancePrefs {
  try { return migrate(JSON.parse(readFileSync(file(), 'utf8'))) } catch { /* First launch. */ }
  return migrate(undefined)
}

// Test and bench pins: they override both variants, are read once, and are never written.
const pinnedOpacity = (name: string) => {
  const value = Number(process.env[name])
  return process.env[name] && Number.isFinite(value) ? Math.round(Math.min(100, Math.max(OPACITY_MIN, value))) : undefined
}
function readPin(): Partial<VariantMaterial> | null {
  const pin: Partial<VariantMaterial> = {}
  const sidebar = pinnedOpacity('KYBERN_WINDOW_OPACITY')
  const content = pinnedOpacity('KYBERN_WINDOW_CONTENT_OPACITY')
  if (sidebar !== undefined) pin.sidebarOpacity = sidebar
  const material = process.env.KYBERN_WINDOW_MATERIAL
  if (material === 'solid') pin.material = 'solid'
  else if (material === 'window') Object.assign(pin, { material: 'translucent', contentOpacity: content ?? sidebar ?? 90 })
  else if (material === 'sidebar') Object.assign(pin, { material: 'translucent', contentOpacity: 100 })
  else if (content !== undefined) pin.contentOpacity = content
  const blur = process.env.KYBERN_WINDOW_BLUR
  if (blur === 'auto') pin.blur = null
  else if (blur && Number.isFinite(Number(blur))) pin.blur = Math.round(Math.min(BLUR_MAX, Math.max(BLUR_MIN, Number(blur))))
  const surface = pinnedOpacity('KYBERN_WINDOW_SURFACE_OPACITY')
  if (surface !== undefined) pin.surfaceOpacity = surface
  return Object.keys(pin).length ? pin : null
}
const PIN = readPin()
const pinned = (prefs: AppearancePrefs): AppearancePrefs => PIN ? { ...prefs, window: { dark: { ...prefs.window.dark, ...PIN }, light: { ...prefs.window.light, ...PIN } } } : prefs

// `stored` is what the file holds; `prefs` is what the app shows (the pins laid over it).
let stored = load()
let prefs = pinned(stored)
const listeners = new Set<() => void>()
export const appearance = () => prefs
/** The variant a preference shows: `system` follows macOS (`shell/appearance.ts`), else the forced launch variant. */
const forced = process.env.KYBERN_APPEARANCE === 'light' || process.env.KYBERN_APPEARANCE === 'dark' ? process.env.KYBERN_APPEARANCE : null
const resolve = (theme: Appearance) => forced ?? (theme === 'system' ? getSystemVariant() : theme)

function apply(next: AppearancePrefs, persist: boolean) {
  if (persist) {
    try {
      mkdirSync(path.dirname(file()), { recursive: true })
      writeFileSync(file(), JSON.stringify({ version: 3, theme: next.theme, window: next.window }))
    } catch (error) {
      // Show what is saved, not a dragged value that would be lost on relaunch; the caller reports the error.
      prefs = pinned(stored)
      for (const listener of listeners) listener()
      throw error
    }
    stored = next
  }
  prefs = pinned(next)
  for (const listener of listeners) listener()
}

/** The base a patch merges into: the stored values while a drag previews, so a pin never leaks into the file. */
const draft = () => (PIN ? stored : prefs)

export function setAppearance(patch: { theme?: Appearance }) {
  const next = { ...draft(), ...(patch.theme ? { theme: patch.theme } : {}) }
  // `motion/themeFade.tsx`: hold the old frame so the new theme cross-fades in.
  if (next.theme !== prefs.theme && resolve(next.theme) !== resolve(prefs.theme)) snapshotBeforeThemeChange()
  apply({ ...next, window: draft().window }, true)
}

/**
 * The preset and the sliders (§5.5): Sidebar only is "content opacity 100". Switching it on remembers the content opacity to
 * come back to; off restores it; a content opacity dragged below 100 is the one to remember.
 */
export function resolveMaterialPatch(current: VariantMaterial, patch: Partial<VariantMaterial> & { sidebarOnly?: boolean }): Partial<VariantMaterial> {
  const { sidebarOnly, ...rest } = patch
  const next: Partial<VariantMaterial> = { ...rest }
  if (sidebarOnly !== undefined && rest.contentOpacity === undefined) {
    if (sidebarOnly && !isSidebarOnly(current)) Object.assign(next, { contentOpacity: 100, lastContentOpacity: current.contentOpacity })
    else if (!sidebarOnly && isSidebarOnly(current)) next.contentOpacity = Math.min(99, current.lastContentOpacity)
  }
  if (rest.contentOpacity !== undefined && rest.contentOpacity < 100 && rest.lastContentOpacity === undefined) next.lastContentOpacity = rest.contentOpacity
  return next
}
function patched(variant: ThemeVariant, patch: Partial<VariantMaterial> & { sidebarOnly?: boolean }): AppearancePrefs {
  const base = draft()
  const current = base.window[variant]
  return { ...base, window: { ...base.window, [variant]: normalizeVariantMaterial({ ...current, ...resolveMaterialPatch(current, patch) }) } }
}
/** Change one variant's window material and save it. Synchronous; throws when the file cannot be written. */
export function setWindowMaterial(variant: ThemeVariant, patch: Partial<VariantMaterial> & { sidebarOnly?: boolean }) { apply(patched(variant, patch), true) }
/** The same, in memory only: a slider being held shows its value live and saves on release. */
export function previewWindowMaterial(variant: ThemeVariant, patch: Partial<VariantMaterial> & { sidebarOnly?: boolean }) { apply(patched(variant, patch), false) }

export function useAppearance() {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }, appearance)
}

onEnvironmentChange(() => {
  stored = load()
  prefs = pinned(stored)
  for (const listener of listeners) listener()
})
