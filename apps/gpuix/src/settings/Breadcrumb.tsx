import { useSyncExternalStore } from 'react'
import { Label, useTheme } from '../ui.tsx'

let title = 'General'
const listeners = new Set<() => void>()
export function setSettingsTitle(next: string) {
  if (next === title) return
  title = next
  for (const listener of listeners) listener()
}
export function SettingsBreadcrumb() {
  const t = useTheme()
  const current = useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => title)
  return <div style={{ position: 'absolute', left: 328, top: 0, height: 46, display: 'flex', alignItems: 'center' }}><Label color={t.textSecondary} size={12}>{`Settings  /  ${current}`}</Label></div>
}
