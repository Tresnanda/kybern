import { Segments } from '../usage/controls.tsx'
import { Icon } from '../icons.tsx'
import { N } from '../nav/glyphs.ts'
import { setNav } from '../nav/store.ts'
import { chooseTab, setDock } from '../dock/store.ts'
import { useEffect, useState } from 'react'
import { notifications, type NotificationStatus } from '../native/notifications.ts'
import type { BackgroundSettings, ProviderKind } from '../../../../packages/kybern-client/src/types.ts'
import { getClient, useApp } from '../state.ts'
import { useNav } from '../nav/store.ts'
import { Label, useTheme } from '../ui.tsx'
import { Button, NumberField, PageBlock, Row, Section, Select, Switch, TextField } from './controls.tsx'
import { latestSettings, updateSettings, useSettings } from './store.ts'
import { useResource } from './resource.ts'

function Pages({ page, count, onChange }: { page: number; count: number; onChange: (page: number) => void }) {
  return count > 8 ? <Row title={`Page ${page + 1} of ${Math.ceil(count / 8)}`}><Button disabled={page === 0} onClick={() => onChange(page - 1)}>Previous</Button><Button disabled={(page + 1) * 8 >= count} onClick={() => onChange(page + 1)}>Next</Button></Row> : null
}

const FIELDS: { key: keyof Omit<BackgroundSettings, 'save_power_on_battery'>; title: string; description: string; unit: string; step: number }[] = [
  { key: 'session_idle_minutes', title: 'Release idle agents after', description: "Closes a quiet thread's agent. The next message starts it again.", unit: 'min', step: 5 },
  { key: 'max_idle_sessions', title: 'Keep idle agents warm', description: 'Past this many, the least recently used one is released first.', unit: 'agents', step: 1 },
  { key: 'terminal_idle_minutes', title: 'Close unattended shells after', description: 'Only shells with no tab open and nothing running.', unit: 'min', step: 5 },
  { key: 'daemon_idle_exit_minutes', title: 'Exit the daemon after', description: 'Once nothing needs it. Keep this off if you use the CLI or remote access.', unit: 'min', step: 5 },
]

export function Background() {
  const t = useTheme()
  const { settings, saving } = useSettings()
  const activity = useResource('daemon.activity', {})
  if (!settings) return null
  const update = (patch: Partial<BackgroundSettings>) => void updateSettings({ background: { ...latestSettings()!.background, ...patch } })
  return <Section title="Background"><div style={{ display: 'flex', flexDirection:'column', paddingLeft:12, paddingRight:12, paddingTop:16, paddingBottom:16, gap: 12 }}><Label color={t.text} size={14} lineHeight={21} weight={500}>Right now</Label><div style={{display:'flex'}}>{[
    ['Agents running', activity.data?.live_sessions], ['Idle, kept warm', activity.data?.idle_sessions], ['Shells open', activity.data?.terminals], ['Clients connected', activity.data?.connections],
  ].map(([label, count], index) => <div key={label} style={{ display: 'flex', flexDirection: 'column', gap: 4, flexGrow: 1, flexBasis:0, paddingLeft:index?16:0,borderLeftWidth:index?1:0,borderColor:t.border }}><Label color={t.text} size={20} lineHeight={24} weight={600}>{count === undefined ? '…' : String(count)}</Label><Label color={t.textSecondary} size={13} lineHeight={19.5}>{label}</Label></div>)}</div><Label color={t.textSecondary} size={14} lineHeight={21.7}>{activity.error || 'Running and approval-bound threads are never released.'}</Label></div>{FIELDS.map((field) => <Row key={field.key} title={field.title} description={field.description}><NumberField label={field.title} value={settings.background[field.key]} unit={field.unit} step={field.step} disabled={saving} onCommit={(value) => update({ [field.key]: value })} /></Row>)}<Row title="Save power on battery" description="Releases idle agents after a minute and holds harness updates until you plug in."><Switch label="Save power on battery" checked={settings.background.save_power_on_battery} disabled={saving} onChange={(save_power_on_battery) => update({ save_power_on_battery })} /></Row></Section>
}

export { Accounts } from './Accounts.tsx'

export { Integrations } from './Integrations.tsx'
export { ComputerUse as Computer } from './Computer.tsx'
