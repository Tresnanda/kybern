// What a machine card says (Settings → Machines, design §5.2), from the machine set's row, the member card the network
// reported and the machine's own `machines.info`. Pure, so the words are tested without a window.
import type { HarnessSummary, MachineCard, MachineInfo } from '../../../../packages/kybern-client/src/types.ts'
import type { MachineRow } from '../machines/index.ts'
import { statusText, statusTone, type Tone } from '../machines/format.ts'
import { PROVIDER_LABEL } from '../shared/lib/format.ts'

export interface MachineCardModel {
  machineId: string
  name: string
  row: MachineRow
  member: boolean
  tone: Tone
  status: string
  /** OS, Tailscale name, version. */
  facts: string[]
  harnesses: string[]
  /** CPU, GPU and memory once the machine answered `machines.info`; null while unknown. */
  hardware: string | null
  /** The machine runs an older version than the one the user is at. */
  behind: boolean
  canPause: boolean
  canRename: boolean
}

const OS_NAME: Record<string, string> = { macos: 'macOS', darwin: 'macOS', windows: 'Windows', linux: 'Linux' }
export const osName = (os: string | undefined | null) => (os ? OS_NAME[os.toLowerCase()] ?? os : null)

export function harnessText(harness: HarnessSummary): string {
  const name = PROVIDER_LABEL[harness.kind] ?? harness.kind
  if (!harness.available) return `${name} not installed`
  if (harness.signed_in === false) return `${name} not signed in`
  return harness.signed_in ? `${name} signed in` : name
}

const gib = (bytes: number) => `${Math.round(bytes / 2 ** 30)} GB`
export function hardwareText(info: MachineInfo | false | undefined): string | null {
  if (!info) return null
  const parts: string[] = []
  if (info.cpu?.model) parts.push(`${info.cpu.model}${info.cpu.logical_cores ? ` · ${info.cpu.logical_cores} cores` : ''}`)
  if (info.gpu?.length) parts.push(info.gpu.slice(0, 2).join(', '))
  if (info.mem?.total_bytes) parts.push(gib(info.mem.total_bytes))
  return parts.length ? parts.join(' · ') : null
}

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
      name: row.name,
      row,
      member: row.member,
      tone: statusTone(row.status),
      status: statusText({ status: row.status, ...(row.lastSeenAt !== undefined ? { lastSeenAt: row.lastSeenAt } : {}), ...(via ? { via } : {}), ...(row.error ? { error: row.error } : {}) }, input.now),
      facts: [osName(card?.os ?? row.os), card?.ts_name, version ? `Version ${version}` : null].filter((fact): fact is string => !!fact),
      harnesses: (info && info.harnesses?.length ? info.harnesses : harnesses).map(harnessText),
      hardware: hardwareText(info),
      behind: !row.isLocal && isBehind(version, input.latest),
      canPause: row.member && !row.isLocal,
      canRename: row.member,
    }
  })
}
