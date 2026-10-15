import { useGpuix, type PublicInstance } from '@gpuix/react'
// The desktop's environment row/menu. Connection state is per native window;
// saved metadata and macOS credentials use the desktop's registry and service.
import { useState, useRef, useSyncExternalStore } from 'react'
import { Icon } from '../icons.tsx'
import { N } from '../nav/glyphs.ts'
import { ContextMenu, MenuItem, MenuLabel, MenuSeparator, muted } from '../nav/overlay.tsx'
import { getClient, useApp } from '../state.ts'
import { Label, useTheme } from '../ui.tsx'
import { accent } from './rows.tsx'
import { useEnvironment, onEnvironmentChange } from '../shell/environment.ts'
import { reconnect } from '../shell/Connection.tsx'
import { toast } from '../shell/toasts.tsx'
import { connectEnvironment, openEnvironmentWindow } from '../environments/actions.ts'
import { showEnvironmentDialog } from '../environments/Dialogs.tsx'
import { localProfile, readRegistry, type EnvironmentProfile } from '../environments/registry.ts'

let menuAt: { x: number; y: number } | null = null
const menuListeners = new Set<() => void>()
function setMenuAt(at: typeof menuAt) { menuAt = at; for (const listener of menuListeners) listener() }
onEnvironmentChange(() => setMenuAt(null))

export function EnvironmentSwitcher() {
  const t = useTheme()
  const active = useEnvironment()
  const status = useApp((s) => s.status)
  const { renderer } = useGpuix()
  const trigger = useRef<PublicInstance>(null)
  const toggle = () => {
    if (menuAt) return setMenuAt(null)
    const bounds = trigger.current && renderer?.getElementBounds?.(trigger.current.id)
    if (bounds) setMenuAt({ x: bounds.x, y: bounds.y + bounds.height + 4 })
  }
  return <div style={{ display: 'flex', paddingLeft: 8, paddingRight: 8, paddingBottom: 6 }}>
    <div ref={trigger} testId="environment-switcher" tabIndex={0} aria-label="Switch environment" onClick={toggle} onKeyDown={(e) => { if (e.key === 'enter' || e.key === 'space') toggle() }} style={{ display: 'flex', alignItems: 'center', gap: 8, flexGrow: 1, minWidth: 0, minHeight: 32, paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4, borderRadius: 10, cursor: 'pointer', hover: { backgroundColor: accent(t) } }}>
      <Icon source={active.local ? N.laptop : N.globe} size={14} color={t.text} /><Label color={t.text} truncate style={{ flexGrow: 1, pointerEvents: 'none' }}>{active.name}</Label>
      <div style={{ pointerEvents: 'none', width: 6, height: 6, borderRadius: 3, backgroundColor: status === 'open' ? '#00bc7d' : status === 'failed' ? t.red : muted(t, 0.4), flexShrink: 0 }} /><Icon source={N.chevronDown} size={12} color={muted(t, 1)} />
    </div>
  </div>
}

export function EnvironmentMenu() {
  const at = useSyncExternalStore((fn) => { menuListeners.add(fn); return () => { menuListeners.delete(fn) } }, () => menuAt)
  return at ? <MenuContents at={at} /> : null
}
function MenuContents({ at }: { at: { x: number; y: number } }) {
  const active = useEnvironment()
  const status = useApp((s) => s.status)
  const [profiles] = useState<EnvironmentProfile[]>(() => { try { return [localProfile, ...readRegistry().environments] } catch { return [localProfile] } })
  const statusLabel = status === 'connecting' || status === 'idle' ? 'Connecting' : status === 'open' ? 'Connected' : status === 'reconnecting' ? 'Reconnecting' : 'Offline'
  const run = (action: () => void) => { try { action() } catch (e) { toast.error('Unable to open environment', { description: e instanceof Error ? e.message : String(e) }) } }
  return <ContextMenu at={at} onClose={() => setMenuAt(null)} width={304} testId="environment-menu">
      <MenuLabel>Environments</MenuLabel>
      <virtual-list style={{ width: '100%', height: Math.min(profiles.length, 6) * 44 }}>
        {profiles.map((profile) => <div key={profile.id} style={{ display: 'flex', alignItems: 'center', gap: 4, height: 44 }}>
          <div style={{ flexGrow: 1, minWidth: 0 }}><MenuItem id={profile.id} testId={`environment-choice-${profile.id}`} icon={profile.local ? N.laptop : N.globe} label={profile.name} detail={profile.id === active.id ? statusLabel : undefined} checked={profile.id === active.id} onSelect={() => run(() => { if (profile.id === active.id) { if (status !== 'open') reconnect() } else connectEnvironment(profile.id) })} /></div>
          <div style={{ width: 28, flexShrink: 0 }}><MenuItem id={`window-${profile.id}`} testId={`environment-window-${profile.id}`} icon={N.window} label="" onSelect={() => run(() => { openEnvironmentWindow(profile.id) })} /></div>
        </div>)}
      </virtual-list>
      <MenuSeparator />
      <MenuItem id="add" testId="environment-add" icon={N.plus} label="Add environment" onSelect={() => showEnvironmentDialog({ kind: 'add' })} />
      <MenuItem id="manage" testId="environment-manage" icon={N.settings} label="Manage environments" onSelect={() => showEnvironmentDialog({ kind: 'manage' })} />
      <MenuItem id="pair" testId="environment-pair" icon={N.globe} label="Pair a device" disabled={status !== 'open' || !getClient()?.info?.scopes.includes('access_write')} onSelect={() => showEnvironmentDialog({ kind: 'pair' })} />
  </ContextMenu>
}
