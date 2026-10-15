import { environmentKey, onEnvironmentChange } from '../shell/environment.ts'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { useSyncExternalStore } from 'react'

export type Appearance = 'light' | 'dark' | 'system'
const file = () => path.join(process.env.KYBERN_CLIENT_CONFIG_DIR ?? path.join(homedir(), 'Library/Application Support/kybern-gpuix'), `appearance-${createHash('sha1').update(environmentKey()).digest('hex').slice(0, 12)}.json`)
let prefs: { theme: Appearance; translucent: boolean } = { theme: 'system', translucent: true }
try {
  const saved = JSON.parse(readFileSync(file(), 'utf8'))
  if (['light', 'dark', 'system'].includes(saved.theme)) prefs.theme = saved.theme
  if (typeof saved.translucent === 'boolean') prefs.translucent = saved.translucent
} catch { /* First launch. */ }
const listeners = new Set<() => void>()
export const appearance = () => prefs
export function setAppearance(patch: Partial<typeof prefs>) {
  const next = { ...prefs, ...patch }
  mkdirSync(path.dirname(file()), { recursive: true })
  writeFileSync(file(), JSON.stringify(next))
  prefs = next
  for (const listener of listeners) listener()
}
export function useAppearance() {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }, appearance)
}

onEnvironmentChange(() => {
  prefs = { theme: 'system', translucent: true }
  try { const saved = JSON.parse(readFileSync(file(), 'utf8')); if (['light', 'dark', 'system'].includes(saved.theme)) prefs.theme = saved.theme; if (typeof saved.translucent === 'boolean') prefs.translucent = saved.translucent } catch { /* First use on this machine. */ }
  for (const listener of listeners) listener()
})
