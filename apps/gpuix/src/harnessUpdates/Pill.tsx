// The sidebar's harness update pill: the harness's logo and "Claude Code" (read as "Claude Code 2.1.330 is out") with Update, or the
// overlapping logos and "3 updates" for several (read as "Updates for …"), above the machines footer. Shown only while
// automatic updates are off; dismissing it hides it until a newer version. It appears in place, without an entrance: it is
// a quiet notice, not an event.
import { N } from '../nav/glyphs.ts'
import { Button } from '../kit/Button.tsx'
import { IconButton } from '../kit/IconButton.tsx'
import { useSettings } from '../settings/store.ts'
import { HarnessMarks } from '../subagents/HarnessMarks.tsx'
import { ink, Label, ProviderMark, useTheme } from '../ui.tsx'
import { kindsOf, pill } from './model.ts'
import { dismissPill, updateHarnesses, useHarnessUpdates } from './store.ts'

const openAgents = () => void import('../settings/SettingsScreen.tsx').then((m) => m.openSettingsTab('agents'))

export function HarnessUpdatePill() {
  const t = useTheme()
  const records = useHarnessUpdates((s) => s.records)
  const dismissed = useHarnessUpdates((s) => s.dismissed)
  const starting = useHarnessUpdates((s) => s.starting)
  const auto = useSettings().settings?.auto_update_harnesses ?? false
  const shown = pill(records, dismissed, auto)
  if (!shown) return null
  const kinds = kindsOf(shown)
  const busy = kinds.some((kind) => starting.includes(kind))
  return (
    <div testId="harness-update-pill" role="status" aria-label={shown.text}
      style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0, minHeight: 32, marginLeft: 8, marginRight: 8, marginBottom: 6, paddingLeft: 10, paddingRight: 4, borderRadius: 16, backgroundColor: ink(t, 0.05) }}>
      <div testId="harness-update-pill-open" role="button" tabIndex={0} aria-label={`${shown.text}. Open Agent providers`} onClick={openAgents}
        onKeyDown={(e) => { if (e.key === 'enter' || e.key === 'space') openAgents() }}
        style={{ display: 'flex', alignItems: 'center', gap: 6, flexGrow: 1, flexShrink: 1, minWidth: 0, cursor: 'pointer' }}>
        {shown.count === 1 && 'kind' in shown ? <ProviderMark kind={shown.kind} size={14} /> : <HarnessMarks kinds={kinds} />}
        <Label color={t.text} size={12} lineHeight={16} truncate style={{ pointerEvents: 'none' }}>{shown.label}</Label>
      </div>
      <Button testId="harness-update-pill-update" size="sm" variant="ghost" accent icon="download" label={shown.action} busy={busy} disabled={busy} onClick={() => void updateHarnesses(kinds)} style={{ paddingRight: 6, marginLeft: 2 }}>Update</Button>
      <IconButton testId="harness-update-pill-dismiss" label="Dismiss" icon={N.x} size="sm" onClick={dismissPill} />
    </div>
  )
}
