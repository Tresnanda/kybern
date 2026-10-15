// The environment switcher under the brand row (`views/EnvironmentSwitcher.tsx`):
// the daemon this window talks to, its connection dot, and the Environments
// menu. This build connects to one daemon (`KYBERN_DATA_DIR` or `KYBERN_URL`),
// so the menu lists that one; adding, managing and pairing stay in the desktop.
import { Icon } from '../icons.tsx'
import { N } from '../nav/glyphs.ts'
import { Menu, MenuItem, MenuLabel, MenuSeparator, muted } from '../nav/overlay.tsx'
import { connect, getClient, useApp } from '../state.ts'
import { Label, useTheme } from '../ui.tsx'
import { accent } from './rows.tsx'
import type { Theme } from '../theme.ts'

const LOCAL = !process.env.KYBERN_URL
const NAME = LOCAL ? 'This Mac' : 'Remote environment'

/** emerald-500 when open, destructive when failed, `muted-foreground/40` otherwise. */
function dotColor(t: Theme, status: string) {
  return status === 'open' ? '#00bc7d' : status === 'failed' ? t.red : muted(t, 0.4)
}

export function EnvironmentSwitcher() {
  const t = useTheme()
  const status = useApp((s) => s.status)
  const statusLabel =
    status === 'connecting' || status === 'idle' ? 'Connecting' : status === 'open' ? 'Connected' : status === 'reconnecting' ? 'Reconnecting' : 'Offline'
  return (
    <div style={{ display: 'flex', paddingLeft: 8, paddingRight: 8, paddingBottom: 6 }}>
      <Menu
        align="start"
        width={304}
        testId="environment-switcher"
        rootStyle={{ flexGrow: 1 }}
        trigger={() => (
          <div
            aria-label="Switch environment"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexGrow: 1,
              minWidth: 0,
              minHeight: 32,
              paddingLeft: 8,
              paddingRight: 8,
              paddingTop: 4,
              paddingBottom: 4,
              borderRadius: 10,
              cursor: 'pointer',
              hover: { backgroundColor: accent(t) },
            }}
          >
            <Icon source={LOCAL ? N.laptop : N.globe} size={14} color={t.text} />
            <Label color={t.text} truncate style={{ flexGrow: 1 }}>
              {NAME}
            </Label>
            <div style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: dotColor(t, status), flexShrink: 0 }} />
            <Icon source={N.chevronDown} size={12} color={muted(t, 1)} />
          </div>
        )}
      >
        <MenuLabel>Environments</MenuLabel>
        <MenuItem
          id="current"
          iconNode={
            <div style={{ display: 'flex', alignSelf: 'flex-start', paddingTop: 6 }}>
              <Icon source={LOCAL ? N.laptop : N.globe} size={16} color={t.text} />
            </div>
          }
          label={NAME}
          detail={statusLabel}
          checked
          onSelect={() => {
            // Picking the current environment after a failure reconnects (desktop `switchEnvironment`).
            if (status === 'failed' && !getClient()) connect()
          }}
        />
        <MenuSeparator />
        <MenuItem id="add" icon={N.plus} label="Add environment" disabled onSelect={() => {}} />
        <MenuItem id="manage" icon={N.settings} label="Manage environments" disabled onSelect={() => {}} />
        <MenuItem id="pair" icon={N.globe} label="Pair a device" disabled onSelect={() => {}} />
      </Menu>
    </div>
  )
}
