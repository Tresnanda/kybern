// Pure rules for Settings › Agent providers › Installed agents (no React), so tests load them directly.
import type { CursorSetupStatus, HarnessUpdate, ProviderStatus } from '../../../../packages/kybern-client/src/types.ts'
import { relativeTime } from '../shared/lib/format.ts'
import { FAILED_UPDATE_LINE } from '../harnessUpdates/model.ts'
import { plainSentence } from '../../../../packages/kybern-client/src/problems.ts'

/** "checked 3h ago", "checked just now", "checked on 2 Nov". */
export function checkedPhrase(iso: string | null, now = Date.now()): string {
  if (!iso) return ''
  const when = relativeTime(iso, now)
  if (!when) return ''
  return when === 'now' ? 'checked just now' : /^\d+[mhdw]$/.test(when) ? `checked ${when} ago` : `checked on ${when}`
}

/** The update line under an installed agent, or null when there is nothing true to say yet. */
export function updateLine(record: HarnessUpdate | undefined, now = Date.now()): { text: string; tone: 'normal' | 'warning' } | null {
  if (!record) return null
  const busy = record.status === 'waiting' || record.status === 'updating'
  // A newer version says so first; the failure of an earlier attempt is behind Show details.
  if (record.update_available && record.latest_version && !busy) return { text: `${record.latest_version} is out`, tone: 'normal' }
  const checked = checkedPhrase(record.checked_at, now)
  switch (record.status) {
    case 'not_checked': return null
    case 'current': return { text: checked ? `Up to date · ${checked}` : 'Up to date', tone: 'normal' }
    case 'updated': return { text: checked ? `Updated · ${checked}. New turns use this version.` : 'Updated. New turns use this version.', tone: 'normal' }
    case 'waiting':
    case 'updating':
    case 'unsupported': return { text: record.message, tone: 'normal' }
    case 'failed': return { text: FAILED_UPDATE_LINE, tone: 'warning' }
  }
}

/** What a working agent still has to say about itself (Pi left a project's models out, or could not list its models), or null. */
export function discoveryNote(provider: ProviderStatus): string | null {
  return provider.available && provider.unavailable_reason ? plainSentence(provider.unavailable_reason.replace(/\s+/g, ' ')) : null
}

/** The technical text of a failed update, for Show details; null when the last update did not fail. */
export function failureDetail(record: HarnessUpdate | undefined): string | null {
  return record?.status === 'failed' && !(record.update_available && record.latest_version) && record.message ? record.message : null
}

/** The version check found a newer version this machine can install: Update now. Cursor's CLI counts; its SDK is set up below. */
export function canUpdateNow(provider: ProviderStatus, record: HarnessUpdate | undefined, customBinary: boolean): boolean {
  return provider.available && !customBinary && !!record?.update_available && !!record.latest_version
}

/** Kybern can run this agent's updater: it is installed, not a custom binary, and its install method has one. */
export function canCheckForUpdates(provider: ProviderStatus, record: HarnessUpdate | undefined, customBinary: boolean): boolean {
  return provider.available && provider.kind !== 'cursor' && !customBinary && record?.status !== 'unsupported'
}


/** What the Cursor row says while its SDK isn't usable, or null once it is. Written for this page: the action sits beside it. */
export function cursorSdkLine({ status, error }: { status: CursorSetupStatus | null; error: string }): string | null {
  if (!status || status.installed) return error || null
  if (status.installing) return `Installing SDK ${status.sdk_version}…`
  if (error) return error
  if (status.problem) return plainSentence(status.problem) ?? 'Cursor’s SDK needs setup. Check again, then try the install.'
  if (status.previous_version) return `SDK ${status.previous_version} is installed. This version of Kybern needs ${status.sdk_version}.`
  return 'Needs Cursor’s SDK, which installs separately from the Cursor app.'
}
