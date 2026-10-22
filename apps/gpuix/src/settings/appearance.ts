import { environmentKey, onEnvironmentChange } from '../shell/environment.ts'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { useSyncExternalStore } from 'react'
import { getSystemVariant } from '../shell/appearance.ts'
import { snapshotBeforeThemeChange } from '../motion/themeFade.tsx'
import { BLUR_MAX, BLUR_MIN, OPACITY_MIN, migrateWindow, normalizeVariantMaterial, type ThemeVariant, type VariantMaterial } from '../platform/translucency.ts'

export type Appearance = 'light' | 'dark' | 'system'
export interface AppearancePrefs { theme: Appearance; window: Record<ThemeVariant, VariantMaterial> }

const file = () => path.join(process.env.KYBERN_CLIENT_CONFIG_DIR ?? path.join(homedir(), 'Library/Application Support/kybern-gpuix'), `appearance-${createHash('sha1').update(environmentKey()).digest('hex').slice(0, 12)}.json`)

/**
 * The saved file in memory (§ "Migration"): `{ version: 2, theme, window: { dark, light } }`. The unversioned file only
 * had `translucent`. Nothing is written back until the next `setAppearance` or `setWindowMaterial`, so a user who never
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
function readPin(): Partial<VariantMaterial> | null {
  const pin: Partial<VariantMaterial> = {}
  const material = process.env.KYBERN_WINDOW_MATERIAL
  if (material === 'solid') pin.material = 'solid'
  else if (material === 'window') Object.assign(pin, { material: 'translucent', sidebarOnly: false })
  else if (material === 'sidebar') Object.assign(pin, { material: 'translucent', sidebarOnly: true })
  const opacity = Number(process.env.KYBERN_WINDOW_OPACITY)
  if (process.env.KYBERN_WINDOW_OPACITY && Number.isFinite(opacity)) pin.opacity = Math.round(Math.min(100, Math.max(OPACITY_MIN, opacity)))
  const blur = process.env.KYBERN_WINDOW_BLUR
  if (blur === 'auto') pin.blur = null
  else if (blur && Number.isFinite(Number(blur))) pin.blur = Math.round(Math.min(BLUR_MAX, Math.max(BLUR_MIN, Number(blur))))
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
    mkdirSync(path.dirname(file()), { recursive: true })
    writeFileSync(file(), JSON.stringify({ version: 2, theme: next.theme, window: next.window }))
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

function patched(variant: ThemeVariant, patch: Partial<VariantMaterial>): AppearancePrefs {
  const base = draft()
  return { ...base, window: { ...base.window, [variant]: normalizeVariantMaterial({ ...base.window[variant], ...patch }) } }
}
/** Change one variant's window material and save it. Synchronous; throws when the file cannot be written. */
export function setWindowMaterial(variant: ThemeVariant, patch: Partial<VariantMaterial>) { apply(patched(variant, patch), true) }
/** The same, in memory only: a slider being held shows its value live and saves on release. */
export function previewWindowMaterial(variant: ThemeVariant, patch: Partial<VariantMaterial>) { apply(patched(variant, patch), false) }

export function useAppearance() {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }, appearance)
}

onEnvironmentChange(() => {
  stored = load()
  prefs = pinned(stored)
  for (const listener of listeners) listener()
})
