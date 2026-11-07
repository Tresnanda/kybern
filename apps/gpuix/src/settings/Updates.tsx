import { SwapOnChange } from '../motion/kit.tsx'
import { isUpdating, type UpdateRow } from '../../../../packages/kybern-client/src/updateRun.ts'
import { Label, ink, useTheme } from '../ui.tsx'
import { StatusDot } from '../sidebar/MachineFilter.tsx'
import { SuccessCheck } from '../motion/SuccessCheck.tsx'
import { Button } from '../kit/Button.tsx'
import { Switch } from '../kit/Switch.tsx'
import { Row, Section } from './controls.tsx'
export function UpdatesSection({ rows, summary, busy, following, followBusy, onUpdate, onRetry, onFollow }: {
  rows: UpdateRow[]; summary: string; busy: boolean; following?: boolean; followBusy: boolean;
  onUpdate: () => void; onRetry: (id: string) => void; onFollow: (enabled: boolean) => void
}) {
  const t = useTheme()
  const active = rows.some(isUpdating)
  return <Section title="Updates" accessory={<Button testId="machines-update-all" busy={busy} disabled={active} onClick={onUpdate}>Update all machines</Button>}>
    <Row title="" description={summary} />
    <div testId="machines-update-results" style={{ display: 'flex', flexDirection: 'column' }}>
      {rows.map(row => <div key={row.machineId} testId={`update-result-${row.machineId}`} style={{ display: 'flex', alignItems: 'center', gap: 12, paddingLeft: 18, paddingRight: 18, paddingTop: 10, paddingBottom: 10 }}>
        {row.phase === 'updated' ? <SuccessCheck size={12} color={t.green} /> : <StatusDot tone={row.phase === 'failed' ? 'bad' : isUpdating(row) ? 'warn' : 'idle'} busy={isUpdating(row)} />}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flexGrow: 1, minWidth: 0 }}>
          <Label color={t.text} size={14} lineHeight={21} weight={500}>{row.name}</Label>
          <SwapOnChange active={row.phase} style={{ justifyContent: 'flex-start' }} innerStyle={{ justifyContent: 'flex-start', minWidth: 0 }}><Label color={row.phase === 'failed' ? t.red : t.textSecondary} size={13} lineHeight={20}>{row.phase === 'failed' ? `Failed: ${row.text}` : row.text}</Label></SwapOnChange>
          {row.progress !== undefined && row.phase === 'downloading' && <div aria-label={`Download ${row.progress}%`} style={{ height: 3, borderRadius: 2, backgroundColor: ink(t, 0.1), width: 160 }}><div style={{ height: 3, borderRadius: 2, width: `${row.progress}%`, backgroundColor: t.textSecondary }} /></div>}
        </div>
        <Label color={t.textSecondary} size={13} lineHeight={20}>{isUpdating(row) && row.targetVersion ? `${row.currentVersion} → ${row.targetVersion}` : row.currentVersion}</Label>
        {row.phase === 'failed' && <Button size="sm" testId={`update-retry-${row.machineId}`} onClick={() => onRetry(row.machineId)}>Retry</Button>}
      </div>)}
    </div>
    <Row title="Keep all machines on the same version" description="A machine updates itself, once it is idle, when another one runs a newer version. A deb or rpm install shows the command to run instead."><Switch aria-label="Keep all machines on the same version" testId="machines-follow-updates" checked={!!following} disabled={following === undefined || followBusy} onCheckedChange={onFollow} /></Row>
  </Section>
}
