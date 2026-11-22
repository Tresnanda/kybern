// Settings › Agent providers › Installed agents. Each row says what is true now: where the agent runs from (or why it can't
// run), when its update was last checked, and the one action that applies. Nothing here claims a state it hasn't read.
import { useEffect, useState } from 'react'
import { loadHarnessUpdates, updateHarnesses, updateOnAllMachines, useHarnessUpdates } from '../harnessUpdates/store.ts'
import { useNetwork } from '../machines/network.ts'
import { machineHub } from '../machines/index.ts'
import type { HarnessUpdate, ProviderKind, ProviderStatus } from '../../../../packages/kybern-client/src/types.ts'
import { requireClient } from '../state.ts'
import { problemLine } from '../problems/describe.ts'
import { plainSentence } from '../../../../packages/kybern-client/src/problems.ts'
import { AGENT_NAMES } from '../onboarding/model.ts'
import { loadProviders } from '../nav/live.ts'
import { canCheckForUpdates, canUpdateNow, cursorSdkLine, discoveryNote, failureDetail, updateLine } from './installedAgentsModel.ts'
import { Label, useTheme } from '../ui.tsx'
import { FONT_MONO } from '../theme.ts'
import { Button } from '../kit/Button.tsx'
import { Row, Section } from './controls.tsx'
import { CursorSdkAction, type CursorSetup } from './Cursor.tsx'

/** While an update waits or runs, its status is re-read on this interval; otherwise the list is read once. */
const BUSY_POLL_MS = 2000

export function InstalledAgents({ providers, customBinary, cursor }: { providers: ProviderStatus[]; customBinary: (kind: ProviderKind) => boolean; cursor: CursorSetup }) {
  const records = useHarnessUpdates((s) => s.records)
  const updating = useHarnessUpdates((s) => s.starting)
  const allMachines = useHarnessUpdates((s) => s.allMachines)
  const members = useNetwork().status?.members ?? []
  const [failure, setFailure] = useState<{ kind: ProviderKind; text: string } | null>(null)
  const [starting, setStarting] = useState<ProviderKind | null>(null)
  const busy = records.some((record) => record.status === 'waiting' || record.status === 'updating')
  useEffect(() => { void loadHarnessUpdates() }, [])
  // Follow a running update to its result; a daemon too old to send `harness_updates.changed` needs the re-read.
  useEffect(() => {
    if (!busy) return
    const timer = setTimeout(() => void loadHarnessUpdates(), BUSY_POLL_MS)
    return () => clearTimeout(timer)
  }, [busy, records])
  // An update that just finished may have changed a version.
  const [wasBusy, setWasBusy] = useState(false)
  useEffect(() => { if (wasBusy && !busy) void loadProviders(true); setWasBusy(busy) }, [busy])
  const check = async (kind: ProviderKind) => {
    setStarting(kind); setFailure(null)
    try { await requireClient().call('harness_updates.run', { kind }); await loadHarnessUpdates() } catch (e) { setFailure({ kind, text: problemLine(e, { action: `check ${AGENT_NAMES[kind] ?? kind} for updates` }) }) } finally { setStarting(null) }
  }
  const nameOf = (id: string) => members.find((member) => member.machine_id === id)?.name ?? 'Another machine'
  // Only with other machines to reach: on one machine, Update now is the same thing.
  const everywhere = members.length > 1
    ? <Button testId="agents-update-all-machines" size="sm" busy={allMachines} disabled={allMachines} onClick={() => void updateOnAllMachines(nameOf, machineHub().localMachineId)}>Update on all machines</Button>
    : null
  return (
    <Section title="Installed agents" accessory={everywhere}>
      {providers.map((provider) => {
        const record = records.find((item) => item.kind === provider.kind)
        return <AgentRow key={provider.kind} provider={provider} record={record} cursor={cursor}
          failure={failure?.kind === provider.kind ? failure.text : null}
          checkable={canCheckForUpdates(provider, record, customBinary(provider.kind))}
          updatable={canUpdateNow(provider, record, customBinary(provider.kind))}
          starting={starting === provider.kind || updating.includes(provider.kind)} anyStarting={starting !== null} onCheck={() => void check(provider.kind)}
          onUpdate={() => void updateHarnesses([provider.kind])} />
      })}
    </Section>
  )
}

function AgentRow({ provider, record, cursor, failure, checkable, updatable, starting, anyStarting, onCheck, onUpdate }: {
  provider: ProviderStatus; record: HarnessUpdate | undefined; cursor: CursorSetup; failure: string | null
  checkable: boolean; updatable: boolean; starting: boolean; anyStarting: boolean; onCheck: () => void; onUpdate: () => void
}) {
  const t = useTheme()
  const isCursor = provider.kind === 'cursor'
  const sdkLine = isCursor ? cursorSdkLine(cursor) : null
  // The first line: where it runs from, or why it can't run.
  const state = provider.available
    ? provider.binary_path ? <Label color={t.textSecondary} size={12} lineHeight={18} font={FONT_MONO} truncate style={{ maxWidth: 451 }}>{startTruncate(provider.binary_path)}</Label> : null
    : <Label color={t.textSecondary} size={14} lineHeight={21.7} style={{ maxWidth: 451 }}>{sdkLine ?? (provider.unavailable_reason && plainSentence(provider.unavailable_reason)) ?? 'Not found on this machine.'}</Label>
  const note = discoveryNote(provider)
  const update = failure ? { text: failure, tone: 'warning' as const } : provider.available && (!isCursor || record?.update_available) ? updateLine(record) : null
  const running = record?.status === 'waiting' || record?.status === 'updating'
  const detail = failure ? null : failureDetail(record)
  const [details, setDetails] = useState(false)
  // Trailing: the version it reports; "Not installed" only when no binary was found at all.
  const trailing = provider.version ?? (provider.available || provider.binary_path || isCursor ? null : 'Not installed')
  return (
    <Row title={provider.display_name} description={
      <div testId={`agent-row-${provider.kind}`} style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        {state}
        {note && <Label color={t.textSecondary} size={13} lineHeight={19.5} style={{ maxWidth: 451 }}>{note}</Label>}
        {update && <Label color={update.tone === 'warning' ? t.warning : t.textSecondary} size={13} lineHeight={19.5} style={{ maxWidth: 451 }}>{update.text}</Label>}
        {detail && (details
          ? <div testId={`agent-failure-detail-${provider.kind}`}><Label color={t.textSecondary} size={12} lineHeight={18} font={FONT_MONO} style={{ maxWidth: 451, userSelect: 'text' }}>{detail}</Label></div>
          : <Button testId={`agent-failure-details-${provider.kind}`} size="sm" variant="ghost" onClick={() => setDetails(true)} style={{ alignSelf: 'flex-start', marginLeft: -8 }}>Show details</Button>)}
      </div>
    }>
      {trailing && <Label color={t.textSecondary} size={12}>{trailing}</Label>}
      {isCursor && !provider.available && <CursorSdkAction setup={cursor} />}
      {updatable && !running
        ? <Button testId={`agent-update-${provider.kind}`} disabled={anyStarting || starting} busy={starting} onClick={onUpdate}>Update now</Button>
        : checkable && <Button testId={`agent-check-${provider.kind}`} disabled={anyStarting || running} busy={starting || running} onClick={onCheck}>
          {running ? (record?.status === 'waiting' ? 'Waiting…' : 'Updating…') : starting ? 'Checking…' : 'Check for updates'}
        </Button>}
    </Row>
  )
}

/** A long path keeps its end, where the executable's name is. */
const startTruncate = (path: string, max = 58) => path.length > max ? `…${path.slice(path.length - max + 1)}` : path
