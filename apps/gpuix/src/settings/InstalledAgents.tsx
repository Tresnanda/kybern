// Settings › Agent providers › Installed agents. Each row says what is true now: where the agent runs from (or why it can't
// run), when its update was last checked, and the one action that applies. Nothing here claims a state it hasn't read.
import { useEffect, useState } from 'react'
import type { HarnessUpdate, ProviderKind, ProviderStatus } from '../../../../packages/kybern-client/src/types.ts'
import { getClient } from '../state.ts'
import { loadProviders } from '../nav/live.ts'
import { canCheckForUpdates, cursorSdkLine, updateLine } from './installedAgentsModel.ts'
import { Label, useTheme } from '../ui.tsx'
import { FONT_MONO } from '../theme.ts'
import { Button } from '../kit/Button.tsx'
import { Row, Section } from './controls.tsx'
import { useResource } from './resource.ts'
import { CursorSdkAction, type CursorSetup } from './Cursor.tsx'

/** While an update waits or runs, its status is re-read on this interval; otherwise the list is read once. */
const BUSY_POLL_MS = 2000

export function InstalledAgents({ providers, customBinary, cursor }: { providers: ProviderStatus[]; customBinary: (kind: ProviderKind) => boolean; cursor: CursorSetup }) {
  const updates = useResource('harness_updates.list', {})
  const [failure, setFailure] = useState<{ kind: ProviderKind; text: string } | null>(null)
  const [starting, setStarting] = useState<ProviderKind | null>(null)
  const records = updates.data?.updates ?? []
  const busy = records.some((record) => record.status === 'waiting' || record.status === 'updating')
  // Follow a running update to its result instead of asking for a manual refresh.
  useEffect(() => {
    if (!busy) return
    const timer = setTimeout(() => updates.refresh(), BUSY_POLL_MS)
    return () => clearTimeout(timer)
  }, [busy, updates.data])
  // An update that just finished may have changed a version.
  const [wasBusy, setWasBusy] = useState(false)
  useEffect(() => { if (wasBusy && !busy) void loadProviders(true); setWasBusy(busy) }, [busy])
  const check = async (kind: ProviderKind) => {
    setStarting(kind); setFailure(null)
    try { await getClient()!.call('harness_updates.run', { kind }); updates.refresh() } catch (e) { setFailure({ kind, text: `Unable to check for updates. ${String(e)}` }) } finally { setStarting(null) }
  }
  return (
    <Section title="Installed agents">
      {providers.map((provider) => {
        const record = records.find((item) => item.kind === provider.kind)
        return <AgentRow key={provider.kind} provider={provider} record={record} cursor={cursor}
          failure={failure?.kind === provider.kind ? failure.text : null}
          checkable={canCheckForUpdates(provider, record, customBinary(provider.kind))}
          starting={starting === provider.kind} anyStarting={starting !== null} onCheck={() => void check(provider.kind)} />
      })}
    </Section>
  )
}

function AgentRow({ provider, record, cursor, failure, checkable, starting, anyStarting, onCheck }: {
  provider: ProviderStatus; record: HarnessUpdate | undefined; cursor: CursorSetup; failure: string | null
  checkable: boolean; starting: boolean; anyStarting: boolean; onCheck: () => void
}) {
  const t = useTheme()
  const isCursor = provider.kind === 'cursor'
  const sdkLine = isCursor ? cursorSdkLine(cursor) : null
  // The first line: where it runs from, or why it can't run.
  const state = provider.available
    ? provider.binary_path ? <Label color={t.textSecondary} size={12} lineHeight={18} font={FONT_MONO} truncate style={{ maxWidth: 451 }}>{startTruncate(provider.binary_path)}</Label> : null
    : <Label color={t.textSecondary} size={14} lineHeight={21.7} style={{ maxWidth: 451 }}>{sdkLine ?? provider.unavailable_reason ?? 'Not found on this machine.'}</Label>
  const update = failure ? { text: failure, tone: 'warning' as const } : provider.available && !isCursor ? updateLine(record) : null
  const running = record?.status === 'waiting' || record?.status === 'updating'
  // Trailing: the version it reports; "Not installed" only when no binary was found at all.
  const trailing = provider.version ?? (provider.available || provider.binary_path || isCursor ? null : 'Not installed')
  return (
    <Row title={provider.display_name} description={
      <div testId={`agent-row-${provider.kind}`} style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        {state}
        {update && <Label color={update.tone === 'warning' ? t.warning : t.textSecondary} size={13} lineHeight={19.5} style={{ maxWidth: 451 }}>{update.text}</Label>}
      </div>
    }>
      {trailing && <Label color={t.textSecondary} size={12}>{trailing}</Label>}
      {isCursor && !provider.available && <CursorSdkAction setup={cursor} />}
      {checkable && <Button testId={`agent-check-${provider.kind}`} disabled={anyStarting || running} busy={starting || running} onClick={onCheck}>
        {running ? (record?.status === 'waiting' ? 'Waiting…' : 'Updating…') : starting ? 'Checking…' : 'Check for updates'}
      </Button>}
    </Row>
  )
}

/** A long path keeps its end, where the executable's name is. */
const startTruncate = (path: string, max = 58) => path.length > max ? `…${path.slice(path.length - max + 1)}` : path
