// Pure rules for harness version notices (no React), so tests load them directly: the sidebar pill, what dismissing
// it remembers, the quiet toast after an automatic update, and the summary of "Update on all machines".
import type { HarnessUpdate, HarnessUpdatesRunAllResult, ProviderKind } from '../../../../packages/kybern-client/src/types.ts'
import { AGENT_NAMES } from '../onboarding/model.ts'

/** The version each harness's pill was dismissed at. A newer version shows the pill again. */
export type Dismissed = Partial<Record<ProviderKind, string>>

/** `label` is what the pill shows, `text` the full sentence a screen reader hears. */
export type Pill =
  | { count: 1; kind: ProviderKind; label: string; text: string }
  | { count: number; kinds: ProviderKind[]; label: string; text: string }

const busy = (record: HarnessUpdate) => record.status === 'waiting' || record.status === 'updating'

/** Harnesses with a newer version the person has not dismissed and that are not already updating. */
export function pending(records: readonly HarnessUpdate[], dismissed: Dismissed): HarnessUpdate[] {
  return records.filter((record) => record.update_available && record.latest_version && !busy(record) && dismissed[record.kind] !== record.latest_version)
}

/** The sidebar pill, or null. Automatic updates install on their own, so they need no pill; several updates are one pill. */
export function pill(records: readonly HarnessUpdate[], dismissed: Dismissed, autoUpdate: boolean): Pill | null {
  if (autoUpdate) return null
  const shown = pending(records, dismissed)
  if (shown.length === 0) return null
  if (shown.length === 1) {
    const [record] = shown
    // The sidebar is narrow: the name and version, which the icon and Update make a notice, always fit; the sentence is for VoiceOver.
    const label = `${AGENT_NAMES[record.kind] ?? record.kind} ${record.latest_version}`
    return { count: 1, kind: record.kind, label, text: `${label} is out` }
  }
  const label = `${shown.length} harness updates`
  return { count: shown.length, kinds: shown.map((record) => record.kind), label, text: label }
}

/** Dismissing remembers the version each pill named, so only a newer one brings it back. */
export function dismiss(records: readonly HarnessUpdate[], dismissed: Dismissed): Dismissed {
  const next = { ...dismissed }
  for (const record of pending(records, dismissed)) next[record.kind] = record.latest_version
  return next
}

/** What the pill's Update button queues. */
export const kindsOf = (shown: Pill): ProviderKind[] => (shown.count === 1 && 'kind' in shown ? [shown.kind] : 'kinds' in shown ? shown.kinds : [])

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
