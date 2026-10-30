// What a machine card says (Settings → Machines, design §5.2), from the machine set's row, the member card the network
// reported and the machine's own `machines.info`. Pure, so the words are tested without a window.
import { looksGeneratedName, shortMachineName } from '../../../../packages/kybern-client/src/forkMachine.ts'
import { harnessChips, machineSpecs, osKind, type HarnessChip, type MachineSpecs, type OsKind } from '../../../../packages/kybern-client/src/machineSpecs.ts'
import type { DoctorReport, MachineCard, MachineId, MachineInfo, NetworkUpdateAllResult, OutboxItem, OutboxKind } from '../../../../packages/kybern-client/src/types.ts'
import type { MachineRow } from '../machines/index.ts'
import { statusText, statusTone, type Tone } from '../machines/format.ts'

export interface MachineCardModel {
  machineId: string
  /** As people say it: no `.local` or tailnet suffix. */
  name: string
  row: MachineRow
  member: boolean
  tone: Tone
  status: string
  /** The machine's version, shown beside its status. */
  version: string | null
  os: OsKind | null
  /** "macOS", or the raw name of an OS we have no mark for. */
  osLabel: string | null
  /** The Tailscale name: a tooltip on the machine's name. */
  tsName: string | null
  /** CPU, memory and GPUs once the machine answered `machines.info`; empty while unknown. */
  specs: MachineSpecs
  /** Only the harnesses the machine has. */
  harnesses: HarnessChip[]
  /** The machine (or its network card) said which harnesses it has; false for one that never answered. */
  harnessesKnown: boolean
  /** The machine runs an older version than the one the user is at. */
  behind: boolean
  canPause: boolean
  canRename: boolean
}

const OS_NAME: Record<string, string> = { macos: 'macOS', darwin: 'macOS', windows: 'Windows', linux: 'Linux' }
export const osName = (os: string | undefined | null) => (os ? OS_NAME[os.toLowerCase()] ?? os : null)

/** Version numbers compared by their numeric parts; a missing or odd one is never "behind". */
export function isBehind(version: string | undefined | null, latest: string | undefined | null): boolean {
  const parse = (v: string | undefined | null) => (v ?? '').split('-')[0]!.split('.').map((n) => Number.parseInt(n, 10))
  const a = parse(version), b = parse(latest)
  if (!a.length || !b.length || a.some(Number.isNaN) || b.some(Number.isNaN)) return false
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0)
  return false
}

export function buildCards(input: {
  rows: readonly MachineRow[]
  members: readonly MachineCard[]
  infos: Record<string, MachineInfo | false>
  /** The version of the machine the user is at: the newest this window can compare with. */
  latest?: string | null
  now?: number
}): MachineCardModel[] {
  const cards = new Map(input.members.map((card) => [card.machine_id, card]))
  const names = new Map(input.rows.map((row) => [row.machineId, row.name]))
  return input.rows.map((row) => {
    const card = cards.get(row.machineId)
    const version = card?.version ?? row.version
    const harnesses = card?.harnesses?.length ? card.harnesses : []
    const info = input.infos[row.machineId]
    const via = card?.relay_via ? names.get(card.relay_via) : row.relayVia ? names.get(row.relayVia) : undefined
    return {
      machineId: row.machineId,
      name: shortMachineName(row.name) || row.name,
      row,
      member: row.member,
      tone: statusTone(row.status),
      status: statusText({ status: row.status, ...(row.lastSeenAt !== undefined ? { lastSeenAt: row.lastSeenAt } : {}), ...(via ? { via } : {}), ...(row.error ? { error: row.error } : {}) }, input.now),
      version: version || null,
      os: osKind(card?.os ?? row.os),
      osLabel: osName(card?.os ?? row.os),
      tsName: card?.ts_name || null,
      specs: machineSpecs(info),
      harnesses: harnessChips(info && info.harnesses?.length ? info.harnesses : harnesses),
      harnessesKnown: !!(info && info.harnesses) || !!card?.harnesses,
      behind: !row.isLocal && isBehind(version, input.latest),
      canPause: row.member && !row.isLocal,
      canRename: row.member,
    }
  })
}

// ---- "Update all machines": what happened on each machine ----

export interface UpdateResultRow {
  machineId: MachineId
  name: string
  started: boolean
  /** "Update started" or the reason it was skipped, in the daemon's words. */
  text: string
}

/** One row per machine the daemon answered for: those it started first, then those it skipped, each with its reason. */
export function updateResultRows(result: NetworkUpdateAllResult, names: ReadonlyMap<MachineId, string>): UpdateResultRow[] {
  const name = (id: MachineId) => names.get(id) ?? 'A machine'
  return [
    ...result.started.map((machineId) => ({ machineId, name: name(machineId), started: true, text: 'Update started' })),
    ...result.skipped.map((item) => ({ machineId: item.machine_id, name: name(item.machine_id), started: false, text: item.reason })),
  ]
}

/** The line above the rows. */
export function updateSummary(result: NetworkUpdateAllResult): string {
  const started = result.started.length
  if (started === 0) return result.skipped.length ? 'Nothing was updated.' : 'No other machines to update.'
  return `Started ${started === 1 ? '1 update' : `${started} updates`}${result.skipped.length ? `, ${result.skipped.length} skipped` : ''}.`
}

// ---- the outbox ----

const OUTBOX_KIND: Record<OutboxKind, string> = {
  thread_create: 'New thread',
  thread_send: 'Message',
  delegate: 'Delegated task',
  files_push: 'Files',
  settings_patch: 'Settings change',
  secrets_put: 'Provider keys',
  fork: 'Fork of a thread',
  move: 'Move of a thread',
  provision: 'Project for another machine',
  plugin_install: 'Install plugin',
  skill_copy: 'Skill',
}

export interface OutboxRowModel {
  id: string
  title: string
  detail: string
  canRetry: boolean
  canCancel: boolean
}

/** Work still on its way to a machine: waiting, being sent, or stuck. Delivered and cancelled items are history. */
export function outboxRows(items: readonly OutboxItem[], names: ReadonlyMap<MachineId, string>): OutboxRowModel[] {
  return items
    .filter((item) => item.state === 'queued' || item.state === 'sending' || item.state === 'failed' || item.state === 'expired')
    .map((item) => {
      const target = names.get(item.target) ?? 'another machine'
      const detail =
        item.state === 'queued' ? `Waiting for ${target}${item.attempts ? ` · tried ${item.attempts} ${item.attempts === 1 ? 'time' : 'times'}` : ''}`
        : item.state === 'sending' ? `Sending to ${target}`
        : item.state === 'expired' ? `Not delivered to ${target} in time`
        : `Did not reach ${target}${item.last_error ? `: ${item.last_error}` : ''}`
      return { id: item.id, title: OUTBOX_KIND[item.kind] ?? item.kind, detail, canRetry: item.state === 'failed' || item.state === 'expired', canCancel: item.state !== 'sending' }
    })
}

// ---- "Name your machines" ----

/** Members whose name looks made up by a host or an installer (`srv1544252`, `VM-3-60-ubuntu`): the ones worth renaming. */
export function unnamedMachines(cards: readonly Pick<MachineCardModel, 'name' | 'member' | 'canRename'>[]): typeof cards {
  return cards.filter((card) => card.member && card.canRename && looksGeneratedName(card.name))
}

// ---- "Run check": the result list ----

export interface DoctorRow {
  id: string
  tone: 'good' | 'warn' | 'bad'
  title: string
  /** What to do next, in the daemon's words; empty for a passing check. */
  next: string
}

/** Failures first, then warnings, then what passed; each keeps the daemon's order. A per-machine check says which machine. */
export function doctorRows(report: DoctorReport, names: ReadonlyMap<MachineId, string>): DoctorRow[] {
  const rank = { fail: 0, warn: 1, pass: 2 } as const
  const rows = report.checks.map((check, index) => ({
    index,
    rank: rank[check.status] ?? 2,
    row: {
      id: `${check.id}:${check.machine_id ?? ''}:${index}`,
      tone: check.status === 'pass' ? 'good' as const : check.status === 'warn' ? 'warn' as const : 'bad' as const,
      title: check.machine_id && names.get(check.machine_id) && !check.title.includes(names.get(check.machine_id)!) ? `${names.get(check.machine_id)}: ${check.title}` : check.title,
      next: check.status === 'pass' ? '' : check.next_step ?? '',
    },
  }))
  return rows.sort((a, b) => a.rank - b.rank || a.index - b.index).map((item) => item.row)
}

/** "All 9 checks passed" or "2 of 9 checks need a look". */
export function doctorSummary(report: DoctorReport): string {
  const bad = report.checks.filter((check) => check.status !== 'pass').length
  return bad ? `${bad} of ${report.checks.length} ${report.checks.length === 1 ? 'check needs' : 'checks need'} a look` : `All ${report.checks.length} ${report.checks.length === 1 ? 'check' : 'checks'} passed`
}
