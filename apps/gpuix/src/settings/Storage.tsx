// Settings → Storage (#298): what Kybern's data takes on this computer, and reclaiming the database's unused space.
// Shows only an action that can run: a reason replaces the button whenever reclaiming cannot start.
import { useEffect, useRef, useState } from 'react'
import type { StorageReclaimStatus, StorageStats } from '../../../../packages/kybern-client/src/types.ts'
import { STORAGE_RECLAIM_PROGRESS_NOTIFICATION } from '../../../../packages/kybern-client/src/types.ts'
import { Icon } from '../icons.tsx'
import { N } from '../nav/glyphs.ts'
import { MeterFill } from '../motion/Meter.tsx'
import { osLabels } from '../platform/os.ts'
import { openSystemSettings } from './external.ts'
import { toastProblem } from '../problems/toast.ts'
import { getClient } from '../state.ts'
import { Label, REDUCED_MOTION, ink, useTheme } from '../ui.tsx'
import { Button } from '../kit/Button.tsx'
import { Row, Section } from './controls.tsx'
import { useResource } from './resource.ts'

/** Below this the daemon reports nothing to reclaim (`NOTHING_TO_RECLAIM_BYTES`). */
const NOTHING_TO_RECLAIM = 32 * 1024 * 1024
const METER = 451
const TABULAR = { fontVariantNumeric: 'tabular-nums' } as never
const counts = new Intl.NumberFormat()

/** Sizes as Finder and Explorer write them: decimal units, one decimal under 100. */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${Math.max(0, Math.round(bytes))} bytes`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1000, unit = 0
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++ }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

export type ReclaimView =
  | { kind: 'loading' }
  | { kind: 'idle'; free: number }
  | { kind: 'moving' }
  | { kind: 'reclaiming'; written: number | null; total: number }
  | { kind: 'done'; freed: number }
  | { kind: 'low-disk'; need: number; free: number }
  | { kind: 'nothing' }
  | { kind: 'failed' }

/** Which state the Reclaim row is in. Running wins, then the last outcome, then what keeps it from starting. */
export function reclaimView(stats: StorageStats | null): ReclaimView {
  if (!stats) return { kind: 'loading' }
  const reclaim = stats.reclaim
  if (reclaim.state === 'running') return { kind: 'reclaiming', written: reclaim.finishing ? null : reclaim.written_bytes ?? null, total: reclaim.total_bytes }
  if (reclaim.state === 'done' && reclaim.freed_bytes > 0) return { kind: 'done', freed: reclaim.freed_bytes }
  if (reclaim.state === 'failed') return { kind: 'failed' }
  if (!stats.media_rewrite.done) return { kind: 'moving' }
  if (stats.reclaimable_bytes < NOTHING_TO_RECLAIM) return { kind: 'nothing' }
  if (stats.free_disk_bytes != null && stats.free_disk_bytes < stats.needed_disk_bytes) return { kind: 'low-disk', need: stats.needed_disk_bytes, free: stats.free_disk_bytes }
  return { kind: 'idle', free: stats.reclaimable_bytes }
}

/** The daemon's numbers, kept current while the page is open: progress arrives as notifications, the rewrite is read every few seconds. */
function useStorageStats() {
  const resource = useResource('storage.stats', {})
  const [stats, setStats] = useState<StorageStats | null>(null)
  useEffect(() => { if (resource.data) setStats(resource.data) }, [resource.data])
  useEffect(() => getClient()?.onNotification(STORAGE_RECLAIM_PROGRESS_NOTIFICATION, (params) => {
    const reclaim = params as StorageReclaimStatus
    setStats((current) => current && { ...current, reclaim })
    if (reclaim.state !== 'running') resource.refresh()
  }), [])
  const moving = !!stats && !stats.media_rewrite.done
  useEffect(() => {
    if (!moving) return
    const id = setInterval(() => resource.refresh(), 4000)
    return () => clearInterval(id)
  }, [moving])
  return { stats, error: resource.error, setStats, refresh: resource.refresh }
}

/** A number that steps down to a new value once (a few text changes, not per-frame motion); Reduce Motion jumps. */
function useSteppedBytes(target: number | null): number | null {
  const [shown, setShown] = useState(target)
  const from = useRef(target)
  useEffect(() => {
    if (target == null) { setShown(null); return }
    const start = from.current
    from.current = target
    if (start == null || start <= target || REDUCED_MOTION) { setShown(target); return }
    const steps = 6
    const timers = Array.from({ length: steps }, (_, i) => setTimeout(() => setShown(Math.round(start - ((start - target) * (i + 1)) / steps)), 70 * (i + 1)))
    return () => timers.forEach(clearTimeout)
  }, [target])
  return shown
}

function Value({ bytes }: { bytes: number | null }) {
  const t = useTheme()
  return <Label color={t.textSecondary} size={14} lineHeight={21} style={TABULAR}>{bytes == null ? '…' : formatBytes(bytes)}</Label>
}

/** A 4 px accent meter on an ink 12 % track, 8 px below the text above it, and one tertiary line. */
function Progress({ value, line, testId }: { value: number; line?: string; testId: string }) {
  const t = useTheme()
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 8, minWidth: 0, maxWidth: METER, width: '100%', overflow: 'hidden' }}>
    <div style={{ display: 'flex', width: METER, height: 4, borderRadius: 2, backgroundColor: ink(t, 0.12), overflow: 'hidden' }}>
      <MeterFill testId={testId} value={value} length={METER} thickness={4} radius={2} color={t.switchOn} />
    </div>
    {line && <Label color={t.textTertiary} size={12} lineHeight={16} style={TABULAR}>{line}</Label>}
  </div>
}

function Described({ children, extra }: { children: React.ReactNode; extra?: React.ReactNode }) {
  return <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flexShrink: 1, width: '100%' }}>{children}{extra}</div>
}

export function Storage() {
  const { stats, error, setStats, refresh } = useStorageStats()
  const [starting, setStarting] = useState(false)
  const start = () => {
    const client = getClient()
    if (!client || starting) return
    setStarting(true)
    void client.call('storage.reclaim', {}).then(
      (reclaim) => setStats((current) => current && { ...current, reclaim }),
      () => setStats((current) => current && { ...current, reclaim: { state: 'failed', message: '' } }),
    ).finally(() => { setStarting(false); refresh() })
  }
  return <StorageView stats={stats} error={!!error} starting={starting} onReclaim={start} />
}

/** The page for given numbers; `storage.fixture.tsx` renders each state with it. */
export function StorageView({ stats, error = false, starting = false, onReclaim }: { stats: StorageStats | null; error?: boolean; starting?: boolean; onReclaim: () => void }) {
  const t = useTheme()
  const view = reclaimView(stats)
  const database = useSteppedBytes(stats?.database_bytes ?? null)
  const here = osLabels().thisComputerInline
  const rewrite = stats?.media_rewrite
  const start = onReclaim
  const secondary = (text: string) => <Label color={t.textSecondary} size={14} lineHeight={21.7} style={{ maxWidth: METER, width: '100%' }}>{text}</Label>

  let description: React.ReactNode = null
  let action: React.ReactNode = null
  switch (view.kind) {
    case 'loading':
      description = secondary(error ? 'Kybern could not read the sizes. Reopen this page to try again.' : 'Reading sizes…')
      break
    case 'idle':
      description = secondary(`Compacts the database to free about ${formatBytes(view.free)}. It takes a few minutes, and you can keep working.`)
      action = <Button testId="storage-reclaim" busy={starting} onClick={start}>Reclaim space</Button>
      break
    case 'moving':
      description = secondary('Available once images finish moving out of the database. Older threads keep showing their images.')
      action = <Button testId="storage-reclaim" disabled>Reclaim space</Button>
      break
    case 'reclaiming':
      description = <Described extra={<Progress testId="storage-reclaim-meter" value={view.written == null ? 1 : view.written / Math.max(1, view.total)} line={view.written == null ? undefined : `${formatBytes(view.written)} of ${formatBytes(view.total)} written`} />}>
        {secondary('Compacting the database. You can keep working; new messages may wait a few seconds at the end.')}
      </Described>
      action = <Button testId="storage-reclaim" busy>Reclaim space</Button>
      break
    case 'done':
      description = <div testId="storage-freed" style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Icon source={N.check} size={14} color={t.green} /><Label color={t.text} size={14} lineHeight={21.7} style={TABULAR}>{`Freed ${formatBytes(view.freed)}.`}</Label></div>
      break
    case 'low-disk':
      description = secondary(`Needs about ${formatBytes(view.need)} free to run, and ${here} has ${formatBytes(view.free)}. Free up some space, then try again.`)
      if (process.platform === 'darwin') action = <Button testId="storage-open-settings" onClick={() => void openSystemSettings('x-apple.systempreferences:com.apple.settings.Storage').catch((error) => toastProblem(error, { action: 'open System Settings' }))}>Open storage settings</Button>
      break
    case 'nothing':
      description = secondary('Nothing to reclaim. The database has no unused space.')
      break
    case 'failed':
      // GPUIX text has one colour per label: the red first sentence sits on its own line.
      description = <div style={{ display: 'flex', flexDirection: 'column', maxWidth: METER, width: '100%' }}>
        <Label color={t.red} size={14} lineHeight={21.7}>Reclaiming stopped before it finished.</Label>
        {secondary('Your data is unchanged. Try again, and keep Kybern open until it’s done.')}
      </div>
      action = <Button testId="storage-reclaim" busy={starting} onClick={start}>Try again</Button>
      break
  }

  const movingLine = rewrite && !rewrite.done
    ? rewrite.total > 0 ? `Moving images out of the database · ${counts.format(Math.min(rewrite.processed, rewrite.total))} of ${counts.format(rewrite.total)}` : 'Moving images out of the database'
    : null
  return <Section title="Storage">
    <Row title="Database" description="Threads, their history and settings."><Value bytes={database} /></Row>
    <Row title="Images and files" description={movingLine
      ? <Described extra={<Progress testId="storage-move-meter" value={rewrite!.total ? rewrite!.processed / rewrite!.total : 0} line={movingLine} />}>{secondary('Screenshots, pasted images and documents agents read.')}</Described>
      : 'Screenshots, pasted images and documents agents read.'}><Value bytes={stats?.files_bytes ?? null} /></Row>
    <div testId={`storage-reclaim-${view.kind}`} style={{ display: 'flex', flexDirection: 'column' }}>
      <Row title="Reclaim space" description={description}>{action}</Row>
    </div>
  </Section>
}
