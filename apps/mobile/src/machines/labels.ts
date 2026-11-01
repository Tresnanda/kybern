// Words for a machine's state (design §5.2 "status", §5.3). Pure, so the Machines
// screen, the filter menu and the tests share one set of sentences.
import type { MachineConnectionStatus } from "../../../../packages/kybern-client/src/machines";

/** "just now", "5 min ago", "2 h ago", "3 d ago". */
export function lastSeenText(at: number | undefined, now = Date.now()): string {
  if (at === undefined) return "";
  const minutes = Math.max(0, (now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${Math.floor(minutes)} min ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} h ago`;
  return `${Math.floor(minutes / 1440)} d ago`;
}

export interface MachineLine {
  status: MachineConnectionStatus;
  /** The connection's own explanation (identity mismatch, unpaired…). */
  error?: string;
  lastSeenAt?: number;
  /** The member a relaying machine goes through, by name. */
  relayVia?: string;
  version?: string;
  connecting?: boolean;
}

/** One line under a machine's name. */
export function machineStatusLine(machine: MachineLine, now = Date.now()): string {
  const version = machine.version ? ` · ${machine.version}` : "";
  switch (machine.status) {
    case "online":
      return `Online${version}`;
    case "relaying":
      return `Relaying${machine.relayVia ? ` via ${machine.relayVia}` : ""}${version}`;
    case "needs-update":
      return `Online${version} · Update Kybern to use it fully`;
    case "paused":
      return "Disconnected on this phone";
    case "unpaired":
      return machine.error ?? "Not paired with this phone";
    default: {
      if (machine.connecting) return "Connecting…";
      const seen = lastSeenText(machine.lastSeenAt, now);
      const base = seen ? `Offline · last seen ${seen}` : "Offline";
      return machine.error ? `${base} · ${machine.error}` : base;
    }
  }
}

/** The dot beside a machine in menus: green online, amber relaying or connecting, grey otherwise. */
export function statusTone(status: MachineConnectionStatus, connecting?: boolean): "positive" | "warning" | "muted" {
  if (status === "online" || status === "needs-update") return "positive";
  if (status === "relaying" || connecting) return "warning";
  return "muted";
}

/** "4 machines · 1 offline". */
export function machinesSummary(statuses: readonly MachineConnectionStatus[]): string {
  const offline = statuses.filter((s) => s === "offline" || s === "unpaired").length;
  const paused = statuses.filter((s) => s === "paused").length;
  const parts = [`${statuses.length} ${statuses.length === 1 ? "machine" : "machines"}`];
  if (offline) parts.push(`${offline} offline`);
  if (paused) parts.push(`${paused} paused`);
  return parts.join(" · ");
}
