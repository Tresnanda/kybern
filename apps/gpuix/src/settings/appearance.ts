import { environmentKey, onEnvironmentChange } from '../shell/environment.ts'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { useSyncExternalStore } from 'react'
import { getSystemVariant } from '../shell/appearance.ts'
import { snapshotBeforeThemeChange } from '../motion/themeFade.tsx'

export type Appearance = 'light' | 'dark' | 'system'
const file = () => path.join(process.env.KYBERN_CLIENT_CONFIG_DIR ?? path.join(homedir(), 'Library/Application Support/kybern-gpuix'), `appearance-${createHash('sha1').update(environmentKey()).digest('hex').slice(0, 12)}.json`)
let prefs: { theme: Appearance; translucent: boolean } = { theme: 'system', translucent: false }
try {
  const saved = JSON.parse(readFileSync(file(), 'utf8'))
  if (['light', 'dark', 'system'].includes(saved.theme)) prefs.theme = saved.theme
  if (typeof saved.translucent === 'boolean') prefs.translucent = saved.translucent
} catch { /* First launch. */ }
const listeners = new Set<() => void>()
export const appearance = () => prefs
/** The variant a preference shows: `system` follows macOS (`shell/appearance.ts`), else the forced launch variant. */
const forced = process.env.KYBERN_APPEARANCE === 'light' || process.env.KYBERN_APPEARANCE === 'dark' ? process.env.KYBERN_APPEARANCE : null
const resolve = (theme: Appearance) => forced ?? (theme === 'system' ? getSystemVariant() : theme)
export function setAppearance(patch: Partial<typeof prefs>) {
  const next = { ...prefs, ...patch }
  // `motion/themeFade.tsx`: hold the old frame so the new theme cross-fades in.
  if (next.theme !== prefs.theme && resolve(next.theme) !== resolve(prefs.theme)) snapshotBeforeThemeChange()
  mkdirSync(path.dirname(file()), { recursive: true })
  writeFileSync(file(), JSON.stringify(next))
  prefs = next
  for (const listener of listeners) listener()
}
export function useAppearance() {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }, appearance)
}

onEnvironmentChange(() => {
  prefs = { theme: 'system', translucent: false }
  try { const saved = JSON.parse(readFileSync(file(), 'utf8')); if (['light', 'dark', 'system'].includes(saved.theme)) prefs.theme = saved.theme; if (typeof saved.translucent === 'boolean') prefs.translucent = saved.translucent } catch { /* First use on this machine. */ }
  for (const listener of listeners) listener()
})
