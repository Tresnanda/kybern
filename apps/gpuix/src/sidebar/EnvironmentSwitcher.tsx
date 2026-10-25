// The desktop's environment row/menu. Connection state is per native window;
// saved metadata and macOS credentials use the desktop's registry and service.
import { useContext, useLayoutEffect, useState, useRef, useSyncExternalStore } from 'react'
import { Tick02Icon } from '@hugeicons/core-free-icons'
import { glyph, Icon } from '../icons.tsx'
import { N } from '../nav/glyphs.ts'
import { Menu, MenuContext, MenuLabel, MenuSeparator, muted } from '../nav/overlay.tsx'
import { getClient, useApp } from '../state.ts'
import { ink, Label, useTheme } from '../ui.tsx'
import { accent } from './rows.tsx'
import { useEnvironment, onEnvironmentChange } from '../shell/environment.ts'
import { reconnect } from '../shell/Connection.tsx'
import { toast } from '../shell/toasts.tsx'
import { connectEnvironment, openEnvironmentWindow } from '../environments/actions.ts'
import { showEnvironmentDialog } from '../environments/Dialogs.tsx'
import { localProfile, readRegistry, type EnvironmentProfile } from '../environments/registry.ts'
import { osLabels } from '../platform/os.ts'

let menuOpen = false
const menuListeners = new Set<() => void>()
function setMenuOpen(open: boolean) { menuOpen = open; for (const listener of menuListeners) listener() }
onEnvironmentChange(() => setMenuOpen(false))

export function EnvironmentSwitcher() {
  const t = useTheme()
  const active = useEnvironment()
  const status = useApp((s) => s.status)
  const open = useSyncExternalStore((fn) => { menuListeners.add(fn); return () => { menuListeners.delete(fn) } }, () => menuOpen)
  // Anchored to the trigger natively (`align="start"`, 4px below, `w-[19rem]`). Placing it from
  // `getElementBounds` opened it 8px to the right: those bounds are the trigger's content box (inside its padding).
  return <div style={{ display: 'flex', paddingLeft: 8, paddingRight: 8, paddingBottom: 6 }}>
    <Menu testId="environment-switcher" open={open} onOpenChange={setMenuOpen} width={304} rootStyle={{ flexGrow: 1 }} trigger={() =>
      <div aria-label="Switch environment" style={{ display: 'flex', alignItems: 'center', gap: 8, flexGrow: 1, minWidth: 0, minHeight: 32, paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4, borderRadius: 10, cursor: 'pointer', hover: { backgroundColor: accent(t) } }}>
        <Icon source={active.local ? N.laptop : N.globe} size={14} color={t.text} /><Label color={t.text} truncate style={{ flexGrow: 1, pointerEvents: 'none' }}>{active.name}</Label>
        <div style={{ pointerEvents: 'none', width: 6, height: 6, borderRadius: 3, backgroundColor: status === 'open' ? '#00bc7d' : status === 'failed' ? t.red : muted(t, 0.4), flexShrink: 0 }} /><Icon source={N.chevronDown} size={12} color={muted(t, 1)} />
      </div>}>
      <MenuContents />
    </Menu>
  </div>
}

function MenuContents() {
  const active = useEnvironment()
  const status = useApp((s) => s.status)
  const [profiles] = useState<EnvironmentProfile[]>(() => { try { return [localProfile, ...readRegistry().environments] } catch { return [localProfile] } })
  const statusLabel = status === 'connecting' || status === 'idle' ? 'Connecting' : status === 'open' ? 'Connected' : status === 'reconnecting' ? 'Reconnecting' : 'Offline'
  const run = (action: () => void | Promise<void>) => { void Promise.resolve().then(action).catch(e => toast.error('Unable to open environment', { description: e instanceof Error ? e.message : String(e) })) }
  const rows = profiles.map((profile, i) => <EnvironmentChoice key={profile.id} last={i === profiles.length - 1} profile={profile} current={profile.id === active.id} status={status} statusLabel={statusLabel}
    onChoose={() => run(() => { if (profile.id === active.id) { if (status !== 'open') reconnect() } else connectEnvironment(profile.id) })}
    onWindow={() => run(() => { openEnvironmentWindow(profile.id) })} />)
  return <>
      <MenuLabel>Environments</MenuLabel>
      {profiles.length > 5 ? <virtual-list style={{ width: '100%', height: 5 * ENV_ROW_PITCH - 2 }}>{rows}</virtual-list> : <div style={{ display: 'flex', flexDirection: 'column' }}>{rows}</div>}
      <MenuSeparator />
      <EnvironmentAction id="add" testId="environment-add" icon={N.plus} label="Add environment" onSelect={() => showEnvironmentDialog({ kind: 'add' })} />
      <EnvironmentAction id="manage" testId="environment-manage" icon={N.settings} label="Manage environments" onSelect={() => showEnvironmentDialog({ kind: 'manage' })} />
      <EnvironmentAction id="pair" testId="environment-pair" icon={N.globe} label="Pair a device" disabled={status !== 'open' || !getClient()?.info?.scopes.includes('access_write')} onSelect={() => showEnvironmentDialog({ kind: 'pair' })} />
  </>
}

// Rows listen for the press too: GPUIX only routes a click to a row inside an overlay that also handles mouse down (`nav/overlay.tsx` MenuItem).
/** An action row at the environment menu's own density: 29px (21px line + `--picker-option-py: .25rem`), 12px gap (`--picker-option-gap: .75rem`). */
function EnvironmentAction({ id, testId, icon, label, disabled = false, onSelect }: { id: string; testId: string; icon: string; label: string; disabled?: boolean; onSelect: () => void }) {
  const t = useTheme()
  const menu = useContext(MenuContext)!
  const select = useRef(onSelect)
  select.current = onSelect
  useLayoutEffect(() => menu.register({ key: id, disabled, keepOpen: false, onSelect: () => select.current() }), [menu.register, id, disabled])
  return <div testId={testId} role="menuitem" aria-label={label} aria-disabled={disabled} onMouseMove={() => { if (!disabled && menu.active !== id) menu.setActive(id) }} onMouseLeave={() => { if (menu.active === id) menu.setActive(null) }} onMouseDown={() => {}} onClick={() => menu.pick(id)} style={{ display: 'flex', alignItems: 'center', gap: 12, height: 29, paddingLeft: 8, paddingRight: 8, borderRadius: 10, opacity: disabled ? 0.64 : 1, ...(menu.active === id && !disabled ? { backgroundColor: t.buttonSecondaryHover } : {}) }}>
    <Icon source={icon} size={16} color={ink(t, 0.8)} style={{ pointerEvents: 'none' }} /><Label color={t.text} size={14} lineHeight={21} truncate style={{ flexGrow: 1, pointerEvents: 'none' }}>{label}</Label>
  </div>
}

/** The current environment's check: 14px at stroke 2.75 (kit.css `.environment-choice [data-slot="menu-radio-indicator"] > svg`). */
const CHECK = glyph(Tick02Icon, 2.75)

/** Rows are 45px with 2px between them (measured in the desktop frontend: two lines + `py-1`, `space-y-0.5`). */
const ENV_ROW_PITCH = 47

/**
 * One saved environment: a two-line choice (name, then status dot and detail) with a
 * check on the current one, and an "Open in a new window" button
 * (`views/EnvironmentSwitcher.tsx`: `.environment-choice`, `environment-choice-status`).
 */
function EnvironmentChoice({ profile, last, current, status, statusLabel, onChoose, onWindow }: { profile: EnvironmentProfile; last: boolean; current: boolean; status: string; statusLabel: string; onChoose: () => void; onWindow: () => void }) {
  const t = useTheme()
  const menu = useContext(MenuContext)!
  const choose = useRef(onChoose), openWindow = useRef(onWindow)
  choose.current = onChoose; openWindow.current = onWindow
  const windowKey = `window-${profile.id}`
  useLayoutEffect(() => menu.register({ key: profile.id, disabled: false, keepOpen: false, onSelect: () => choose.current() }), [menu.register, profile.id])
  useLayoutEffect(() => menu.register({ key: windowKey, disabled: false, keepOpen: false, onSelect: () => openWindow.current() }), [menu.register, windowKey])
  const choiceActive = menu.active === profile.id, windowActive = menu.active === windowKey
  const detail = current ? statusLabel : profile.local ? `On ${osLabels().thisComputerInline}` : profile.ssh ? 'SSH connection' : 'Remote environment'
  const dot = current && status === 'open' ? '#00bc7d' : current && status === 'failed' ? t.red : muted(t, 0.4)
  return <div style={{ paddingBottom: last ? 0 : 2 }}><div style={{ display: 'flex', alignItems: 'center', gap: 4, height: 45, paddingRight: 4, borderRadius: 10, backgroundColor: choiceActive || windowActive ? t.buttonSecondaryHover : current ? t.buttonSecondary : 'transparent' }}>
    <div testId={`environment-choice-${profile.id}`} role="menuitem" aria-checked={current} aria-label={profile.name} onMouseMove={() => { if (menu.active !== profile.id) menu.setActive(profile.id) }} onMouseLeave={() => { if (menu.active === profile.id) menu.setActive(null) }} onMouseDown={() => {}} onClick={() => menu.pick(profile.id)} style={{ display: 'flex', alignItems: 'center', gap: 12, flexGrow: 1, minWidth: 0, height: 45, paddingLeft: 8, paddingRight: 8 }}>
      <Icon source={profile.local ? N.laptop : N.globe} size={16} color={ink(t, 0.8)} style={{ opacity: 0.8, pointerEvents: 'none' }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexGrow: 1, minWidth: 0, pointerEvents: 'none' }}>
        <Label color={t.text} size={14} lineHeight={19.25} truncate>{profile.name}</Label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}><div style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: dot, flexShrink: 0 }} /><Label color={muted(t, 1)} size={11.5} lineHeight={15.8} truncate>{detail}</Label></div>
      </div>
      <div style={{ display: 'flex', width: 14, height: 14, flexShrink: 0, pointerEvents: 'none' }}>{current && <Icon source={CHECK} size={14} color={t.text} />}</div>
    </div>
    <div testId={`environment-window-${profile.id}`} role="menuitem" aria-label={`Open ${profile.name} in a new window`} onMouseMove={() => { if (menu.active !== windowKey) menu.setActive(windowKey) }} onMouseLeave={() => { if (menu.active === windowKey) menu.setActive(null) }} onMouseDown={() => {}} onClick={() => menu.pick(windowKey)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, flexShrink: 0, borderRadius: 10, backgroundColor: windowActive ? t.buttonSecondary : 'transparent' }}>
      <Icon source={N.window} size={16} color={muted(t, 1)} style={{ pointerEvents: 'none' }} />
    </div>
  </div></div>
}
