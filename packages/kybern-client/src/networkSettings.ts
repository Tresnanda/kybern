// What the network's settings say about work in flight, shared by GPUIX and mobile (Settings → Machines): the result of "Update all
// machines", the outbox's rows and the network check's list. Pure functions over the daemon's own results.
import type { DoctorReport, MachineId, NetworkUpdateAllResult, OutboxItem, OutboxKind } from './types.ts'

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
  const name = (id: MachineId) => names.get(id) ?? "A machine"
  return [
    ...result.started.map((machineId) => ({ machineId, name: name(machineId), started: true, text: "Update started" })),
    ...result.skipped.map((item) => ({ machineId: item.machine_id, name: name(item.machine_id), started: false, text: item.reason })),
  ]
}

/** The line above the rows. */
export function updateSummary(result: NetworkUpdateAllResult): string {
  const started = result.started.length
  if (started === 0) return result.skipped.length ? "Nothing was updated." : "No other machines to update."
  return `Started ${started === 1 ? "1 update" : `${started} updates`}${result.skipped.length ? `, ${result.skipped.length} skipped` : ""}.`
}

// ---- the outbox ----

const OUTBOX_KIND: Record<OutboxKind, string> = {
  thread_create: "New thread",
  thread_send: "Message",
  delegate: "Delegated task",
  files_push: "Files",
  settings_patch: "Settings change",
  secrets_put: "Provider keys",
  fork: "Fork of a thread",
  move: "Move of a thread",
  provision: "Project for another machine",
  plugin_install: "Install plugin",
  skill_copy: "Skill",
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
    .filter((item) => item.state === "queued" || item.state === "sending" || item.state === "failed" || item.state === "expired")
    .map((item) => {
      const target = names.get(item.target) ?? "another machine"
      const detail =
        item.state === "queued" ? `Waiting for ${target}${item.attempts ? ` · tried ${item.attempts} ${item.attempts === 1 ? "time" : "times"}` : ""}`
        : item.state === "sending" ? `Sending to ${target}`
        : item.state === "expired" ? `Not delivered to ${target} in time`
        : `Did not reach ${target}${item.last_error ? `: ${item.last_error}` : ""}`
      return { id: item.id, title: OUTBOX_KIND[item.kind] ?? item.kind, detail, canRetry: item.state === "failed" || item.state === "expired", canCancel: item.state !== "sending" }
    })
}


// ---- "Run check": the result list ----

export interface DoctorRow {
  id: string
  tone: "good" | "warn" | "bad"
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
      id: `${check.id}:${check.machine_id ?? ""}:${index}`,
      tone: check.status === "pass" ? "good" as const : check.status === "warn" ? "warn" as const : "bad" as const,
      title: check.machine_id && names.get(check.machine_id) && !check.title.includes(names.get(check.machine_id)!) ? `${names.get(check.machine_id)}: ${check.title}` : check.title,
      next: check.status === "pass" ? "" : check.next_step ?? "",
    },
  }))
  return rows.sort((a, b) => a.rank - b.rank || a.index - b.index).map((item) => item.row)
}

/** "All 9 checks passed" or "2 of 9 checks need a look". */
export function doctorSummary(report: DoctorReport): string {
  const bad = report.checks.filter((check) => check.status !== "pass").length
  return bad ? `${bad} of ${report.checks.length} ${report.checks.length === 1 ? "check needs" : "checks need"} a look` : `All ${report.checks.length} ${report.checks.length === 1 ? "check" : "checks"} passed`
}
