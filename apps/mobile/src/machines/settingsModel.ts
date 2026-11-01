// The words and groupings of the Machines screens added for the network (ADE-99 §2.1). Pure, so they are tested without a phone.
import { doctorRows, outboxRows, type DoctorRow } from "../../../../packages/kybern-client/src/networkSettings";
import type { DoctorReport, MachineId, OutboxItem, TokenInfo } from "../../../../packages/kybern-client/src/types";

export const MACHINES_COPY = {
  renameTitle: "Rename machine",
  renameField: "Machine name",
  renamePlaceholder: "For example, Studio PC",
  renameAction: "Rename",
  renameError: "Unable to rename. Try again.",
  pause: "Pause on your network",
  resume: "Resume on your network",
  pauseConfirmTitle: (name: string) => `Pause ${name} on your network?`,
  pauseConfirmBody: "Your other machines stop sending it work until you resume it. Its threads stay on it.",
  pauseConfirmButton: "Pause machine",
  disconnect: "Disconnect on this phone",
  reconnect: "Reconnect on this phone",
  disconnected: "Disconnected on this phone",
  yourNetwork: "Your network",
  useNetwork: "Use your network",
  useNetworkFooter: "Machines signed in to the same Tailscale account join without a code.",
  offTitle: (name: string) => `Turn off your network on ${name}?`,
  offBody: (name: string) => `This phone can still reach ${name}. Your other machines stop syncing with it.`,
  offButton: "Turn off",
  follow: "Keep all machines on the same version",
  followFooter: "A machine updates itself, once it is idle, when another one runs a newer version.",
  updateAll: "Update all machines",
  check: "Check the network",
  checkError: "Unable to check the network. Try again.",
  outbox: "Outbox",
  retry: "Retry",
  cancel: "Cancel",
  keep: "Keep",
  cancelSend: "Cancel send",
  devices: "Paired devices",
} as const;

// ---- the outbox ----

export interface OutboxEntry {
  id: string;
  /** The member whose outbox holds the item: Retry and Cancel go to it. */
  holder: MachineId;
  title: string;
  detail: string;
  /** The machine the work is for. */
  targetName: string;
  canRetry: boolean;
  canCancel: boolean;
}

/** Items waiting, sending or stuck, across every live member's outbox, newest first. Delivered and cancelled ones are history. */
export function outboxEntries(lists: readonly { holder: MachineId; items: readonly OutboxItem[] }[], names: ReadonlyMap<MachineId, string>): OutboxEntry[] {
  const merged = lists.flatMap(({ holder, items }) => items.map((item) => ({ holder, item })));
  merged.sort((a, b) => Date.parse(b.item.created_at) - Date.parse(a.item.created_at));
  const seen = new Set<string>();
  const unique = merged.filter(({ item }) => !seen.has(item.id) && !!seen.add(item.id));
  const rows = new Map(outboxRows(unique.map(({ item }) => item), names).map((row) => [row.id, row]));
  return unique.flatMap(({ holder, item }) => {
    const row = rows.get(item.id);
    if (!row) return [];
    const targetName = names.get(item.target) ?? "that machine";
    // The spec's words for a failure: "Failed: <error>".
    const detail = item.state === "failed" ? `Failed: ${item.last_error || `${targetName} did not answer`}` : row.detail;
    return [{ id: item.id, holder, title: row.title, detail, targetName, canRetry: row.canRetry, canCancel: row.canCancel }];
  });
}

export const cancelOutboxText = (entry: Pick<OutboxEntry, "title" | "targetName">) => ({
  title: `Cancel this ${entry.title.charAt(0).toLowerCase()}${entry.title.slice(1)}?`,
  message: `It will not be sent to ${entry.targetName}.`,
});

// ---- the network check ----

export const checkRows = (report: DoctorReport, names: ReadonlyMap<MachineId, string>): DoctorRow[] => doctorRows(report, names);

// ---- paired devices across machines ----

export interface DeviceToken {
  machineId: MachineId;
  machineName: string;
  token: TokenInfo;
}

export interface DeviceGroup {
  /** The device's name; tokens that carry the same label are one device. */
  label: string;
  machines: string[];
  tokens: DeviceToken[];
  lastUsedAt?: string;
}

/** "On Mac Studio", "On Mac Studio and satyamas", "On Mac Studio, satyamas and instabox". */
export function reachText(machines: readonly string[]): string {
  if (machines.length <= 1) return `On ${machines[0] ?? "this machine"}`;
  return `On ${machines.slice(0, -1).join(", ")} and ${machines[machines.length - 1]}`;
}

/** One entry per device across every machine, the most recently used first. Revoked tokens are not devices any more. */
export function groupDevices(entries: readonly DeviceToken[]): DeviceGroup[] {
  const groups = new Map<string, DeviceGroup>();
  for (const entry of entries) {
    if (entry.token.revoked) continue;
    const key = entry.token.label.trim().toLowerCase();
    const group = groups.get(key) ?? { label: entry.token.label.trim() || "Unnamed device", machines: [], tokens: [] };
    if (!group.machines.includes(entry.machineName)) group.machines.push(entry.machineName);
    group.tokens.push(entry);
    const used = entry.token.last_used_at ?? undefined;
    if (used && (!group.lastUsedAt || Date.parse(used) > Date.parse(group.lastUsedAt))) group.lastUsedAt = used;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => (Date.parse(b.lastUsedAt ?? "") || 0) - (Date.parse(a.lastUsedAt ?? "") || 0) || a.label.localeCompare(b.label));
}

export function deviceSubtitle(group: DeviceGroup): string {
  const used = group.lastUsedAt ? `Last used ${new Date(group.lastUsedAt).toLocaleDateString()}` : "Not used yet";
  return `${reachText(group.machines)} · ${used}`;
}

// ---- a machine's page ----

const OS_NAME: Record<string, string> = { macos: "macOS", darwin: "macOS", windows: "Windows", linux: "Linux" };
/** "macOS", "Windows", "Linux"; a name we do not know is shown as the machine reported it. */
export const osLabel = (os: string | null | undefined): string | null => (os ? (OS_NAME[os.toLowerCase()] ?? os) : null);

/** The rows of the Specs group: label and value, only the ones the machine answered. */
export function specRows(os: string | null | undefined, specs: { cpu: string | null; cores: string | null; memory: string | null; gpus: string[] }): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  const system = osLabel(os);
  if (system) rows.push({ label: "System", value: system });
  if (specs.cpu) rows.push({ label: "Processor", value: specs.cores ? `${specs.cpu} · ${specs.cores}` : specs.cpu });
  else if (specs.cores) rows.push({ label: "Processor", value: specs.cores });
  if (specs.memory) rows.push({ label: "Memory", value: specs.memory });
  if (specs.gpus.length) rows.push({ label: "Graphics", value: specs.gpus.join(", ") });
  return rows;
}
