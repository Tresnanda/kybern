import { useEffect } from 'react'
import { Button } from '../kit/Button.tsx'
import { Label, useTheme } from '../ui.tsx'
import { Section } from '../settings/controls.tsx'
import { Spinner } from '../kit/Spinner.tsx'
import { ErrorText } from '../environments/kit.tsx'
import { showEnvironmentDialog } from '../environments/Dialogs.tsx'
import { toast } from '../shell/toasts.tsx'
import { machineSetup, useMachineSetup } from './setupRuntime.ts'
import { setupBusy, type SetupRow, type SetupState } from './setup.ts'
import { MachineSymbol, SETUP_ICONS, SetupStatus } from './SetupVisuals.tsx'
import { Icon } from '../icons.tsx'
import { N } from '../nav/glyphs.ts'

export function MachineSetupSection() {
  const state = useMachineSetup()
  useEffect(() => { void machineSetup().start() }, [])
  const retry = (row: SetupRow, install: boolean) => { void machineSetup().retry(row.target.id, install).catch(error => toast.error('Unable to set up this machine', { description: String(error) })) }
  return <MachineSetupPanel state={state} onCheck={() => { void machineSetup().start(true) }} onRetry={row => retry(row, false)} onInstall={row => retry(row, true)} onCancel={row => machineSetup().cancel(row.target.id)} onAccess={row => showEnvironmentDialog({ kind: 'add', target: row.target.address ?? row.target.target, name: row.target.name })} />
}

/** The same native panel is rendered by the deterministic fixture; status is never inferred from a timer. */
export function MachineSetupPanel({ state, onCheck, onRetry, onInstall, onCancel, onAccess }: {
  state: SetupState
  onCheck: () => void
  onRetry: (row: SetupRow) => void
  onInstall: (row: SetupRow) => void
  onCancel: (row: SetupRow) => void
  onAccess: (row: SetupRow) => void
}) {
  const t = useTheme()
  return <Section title="Connect your other machines" accessory={<Button testId="machine-setup-check" size="sm" busy={state.discovering} disabled={state.rows.some(row => setupBusy(row.phase))} onClick={onCheck}>Check again</Button>}>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, padding: 18 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <Icon name="shield" size={18} color={t.iconSecondary} style={{ marginTop: 2 }} />
        <div style={{ flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0 }}><Label color={t.textSecondary} size={13} lineHeight={20}>Connect through saved pairing or verified SSH access. Machines you switched off stay off.</Label></div>
      </div>
      {!state.rows.length && <Label color={t.textSecondary} size={13} lineHeight={20}>{state.discovering ? 'Checking saved connections…' : 'No other saved connections found. Add a machine by SSH or pairing invitation below.'}</Label>}
      {state.rows.map(row => <div key={row.target.id} testId={`machine-setup-${row.target.id}`} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <MachineSymbol os={row.target.os} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
            <Label color={t.text} size={14} lineHeight={21} weight={500} style={{ flexGrow: 1, flexShrink: 1, minWidth: 0 }}>{row.target.name}</Label>
            {setupBusy(row.phase) ? <>
              <Spinner size={14} color={t.textSecondary} />
              <Button testId={`machine-setup-cancel-${row.target.id}`} size="sm" onClick={() => onCancel(row)}>Cancel</Button>
            </> : row.phase === 'install' ? <Button testId={`machine-setup-install-${row.target.id}`} icon={SETUP_ICONS.download} size="sm" onClick={() => onInstall(row)}>Install and connect</Button>
              : row.phase === 'access' ? <Button testId={`machine-setup-access-${row.target.id}`} icon="shield" size="sm" onClick={() => onAccess(row)}>Set up access</Button>
                : ['error', 'canceled', 'off'].includes(row.phase) ? <Button testId={`machine-setup-retry-${row.target.id}`} icon={N.refresh} size="sm" onClick={() => onRetry(row)}>Retry</Button> : null}
          </div>
          {!setupBusy(row.phase) && <div style={{ display: 'flex' }}><SetupStatus kind={row.phase === 'ready' ? 'ready' : row.phase === 'error' ? 'error' : row.phase === 'off' ? 'off' : row.phase === 'install' ? 'install' : 'waiting'} text={row.phase === 'ready' ? 'Network enabled' : row.phase === 'error' ? 'Needs attention' : row.phase === 'off' ? 'Switched off' : row.phase === 'install' ? 'Not installed' : row.phase === 'canceled' ? 'Canceled' : 'Access needed'} /></div>}
          <Label color={row.phase === 'error' ? t.red : t.textSecondary} size={13} lineHeight={20}>{row.detail}</Label>
          {row.phase === 'install' && <Label color={t.textSecondary} size={12} lineHeight={18}>Runs as a persistent user service. Agent sign-ins stay unchanged.</Label>}
          {row.target.online === false && <Label color={t.textSecondary} size={12} lineHeight={18}>Offline on Tailscale. Turn the machine on before setting up access.</Label>}
        </div>
      </div>)}
      {state.error && <ErrorText>{state.error}</ErrorText>}
    </div>
  </Section>
}
