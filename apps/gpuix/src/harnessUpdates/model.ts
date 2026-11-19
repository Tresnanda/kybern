// Pure rules for harness version notices (no React), so tests load them directly: the rows in the rail's update card, what
// dismissing one remembers, the quiet toast after an automatic update, and the summary of "Update on all machines".
import type { HarnessUpdate, HarnessUpdatesRunAllResult, ProviderKind } from '../../../../packages/kybern-client/src/types.ts'
import { AGENT_NAMES } from '../onboarding/model.ts'

/** The version each harness was dismissed at. A newer version shows it again. */
export type Dismissed = Partial<Record<ProviderKind, string>>

/** One harness with a newer version, as a row of the rail's update card. */
export interface UpdateRow {
  kind: ProviderKind
  /** "Claude Code". The version is in `text`, for a screen reader. */
  name: string
  /** "Claude Code 2.1.330 is out". */
  text: string
  /** Waiting for its agents to be idle, or updating: the row stays, with a busy button, until the new version is in. */
  busy: boolean
  /** The last attempt did not finish. */
  failed: boolean
}

/** What a failed row says; the technical text stays in Settings › Agent providers. */
export const FAILED_UPDATE_LINE = 'The last update didn’t finish. Try again, or run the updater in your terminal.'

const waiting = (record: HarnessUpdate) => record.status === 'waiting' || record.status === 'updating'

const newer = (record: HarnessUpdate, dismissed: Dismissed) =>
  !!record.update_available && !!record.latest_version && dismissed[record.kind] !== record.latest_version

/**
 * The harness rows of the rail's update card. Automatic updates install on their own, so they need none. A row that was
 * asked to update stays, busy, until the record says the new version is in (it then has no newer version).
 */
export function updateRows(records: readonly HarnessUpdate[], dismissed: Dismissed, autoUpdate: boolean): UpdateRow[] {
  if (autoUpdate) return []
  return records.filter((record) => newer(record, dismissed)).map((record) => {
    const name = AGENT_NAMES[record.kind] ?? record.kind
    return { kind: record.kind, name, text: `${name} ${record.latest_version} is out`, busy: waiting(record), failed: record.status === 'failed' }
  })
}

/** The rail update button's accessible name, or null when it has nothing to show: a Kybern release, a harness, or both. */
export function railName(appVersion: string | null, rows: readonly UpdateRow[]): string | null {
  return rows.length > 0 || appVersion ? 'Updates available' : null
}

/** Dismissing remembers the version a row named, so only a newer one brings it back. Without a kind it dismisses every pending row. */
export function dismiss(records: readonly HarnessUpdate[], dismissed: Dismissed, kind?: ProviderKind): Dismissed {
  const next = { ...dismissed }
  for (const record of records.filter((r) => newer(r, dismissed) && (kind === undefined || r.kind === kind))) next[record.kind] = record.latest_version
  return next
}

/** The version to show for an installed harness: the number from its `--version` line. */
export function shortVersion(line: string | null | undefined): string | null {
  if (!line) return null
  const token = line.split(/[\s(),]+/).map((part) => part.replace(/^rust-v/, '').replace(/^v(?=\d)/, '')).find((part) => /^\d+\.\d/.test(part))
  return token ?? null
}

/** The harnesses an automatic update just finished for: their record moved to `updated` with a new version. */
export function justUpdated(before: readonly HarnessUpdate[], after: readonly HarnessUpdate[]): HarnessUpdate[] {
  const previous = new Map(before.map((record) => [record.kind, record]))
  return after.filter((record) => {
    const was = previous.get(record.kind)
    return record.status === 'updated' && !!was && (was.status !== 'updated' || was.version !== record.version)
  })
}

/** "Updated Claude Code to 2.1.330", or "Updated Claude Code and Codex" for several. */
export function updatedText(records: readonly HarnessUpdate[]): string | null {
  if (records.length === 0) return null
  if (records.length === 1) {
    const [record] = records
    const version = shortVersion(record.version)
    return `Updated ${AGENT_NAMES[record.kind] ?? record.kind}${version ? ` to ${version}` : ''}`
  }
  const names = records.map((record) => AGENT_NAMES[record.kind] ?? record.kind)
  return `Updated ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

export interface RunAllSummary {
  /** The success line, or null when nothing started anywhere. */
  started: string | null
  /** Machines that were not updated for a reason someone may act on, each with its own headline. */
  problems: { machineId: string; title: string; body: string; offline: boolean }[]
}

const UP_TO_DATE = /up to date|not installed/i

/**
 * "Update on all machines", in words. A machine already up to date is no problem; an offline one is named, and so is
 * any other that could not start, with the machine's own reason as the sentence.
 */
export function runAllSummary(result: HarnessUpdatesRunAllResult, nameOf: (machineId: string) => string, localId: string | undefined): RunAllSummary {
  const machines = result.started.length
  const started = machines === 0 ? null : machines === 1
    ? (result.started[0].machine_id === localId ? 'Updating harnesses on this computer' : `Updating harnesses on ${nameOf(result.started[0].machine_id)}`)
    : `Updating harnesses on ${machines} machines`
  const problems = result.skipped.filter((skipped) => !UP_TO_DATE.test(skipped.reason)).map((skipped) => {
    const here = skipped.machine_id === localId
    const name = here ? 'this computer' : nameOf(skipped.machine_id)
    const offline = skipped.reason === 'Offline'
    return offline
      ? { machineId: skipped.machine_id, title: `${name} is offline`, body: 'Its harnesses update the next time you run this while it is online.', offline }
      : { machineId: skipped.machine_id, title: here ? 'Couldn’t update harnesses on this computer' : `Couldn’t update harnesses on ${name}`, body: sentence(skipped.reason), offline }
  })
  return { started, problems }
}

const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`)
