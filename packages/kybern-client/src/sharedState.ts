// Shared state across machines, for clients (ADE-86 M5; design §9.1 and §9.2). Plain functions over the
// daemon's `settings.network_view` and over the `federation` block of a merged notes or tasks result.
//
// Settings: a shared field whose machines disagree is **Mixed**. The popover lists each machine's value and
// offers "Use <value> on all machines", which is `settings.share` with that one field. Per-machine fields
// (binaries, env, accounts, ports, access…) are never in the view, so a client cannot offer to share them.
//
// Notes and tasks: `machine: "all"` returns one merged list. `federation.sections` says which machine
// contributed which ids and `footer` names the machines that were left out, so a partial list never looks
// complete. Each machine is the only writer of its own notes and tasks.
import type {
  Federation,
  FederationSection,
  MachineId,
  SettingsFieldView,
  SettingsMachineView,
  SettingsNetworkView,
  SettingsShareParams,
  SkipReason,
} from "./types.ts";

// ---- settings: Mixed ----

/** One machine's value of a field, joined with the machine it belongs to. */
export interface FieldMachineValue {
  machine: SettingsMachineView;
  /** The machine reported a value (an unset optional field reports `null`). */
  known: boolean;
  value: unknown;
  /** A queued change for this machine has not arrived yet. */
  pending: boolean;
}

export function fieldOf(view: SettingsNetworkView, path: string): SettingsFieldView | undefined {
  return view.fields.find((field) => field.path === path);
}

/** The fields whose machines disagree. */
export function mixedFields(view: SettingsNetworkView): SettingsFieldView[] {
  return view.fields.filter((field) => field.mixed);
}

export function isMixed(view: SettingsNetworkView, path: string): boolean {
  return fieldOf(view, path)?.mixed === true;
}

/** Each machine's value of `path`, in the view's machine order (this machine first). */
export function machineValues(view: SettingsNetworkView, path: string): FieldMachineValue[] {
  const field = fieldOf(view, path);
  if (!field) return [];
  return view.machines.map((machine, index) => {
    const entry = field.values[index];
    const known = entry !== undefined && entry.machine_id === machine.id && "value" in entry && entry.value !== undefined;
    return { machine, known, value: known ? entry.value : undefined, pending: field.pending.includes(machine.id) };
  });
}

/** What a machine looks like in the popover when it gave no value. */
export function silentReason(machine: SettingsMachineView): string | null {
  switch (machine.state) {
    case "reported":
      return null;
    case "offline":
      return `${machine.name} is offline. A change waits for it.`;
    case "unsupported":
      return `${machine.name} needs a newer Kybern to share settings.`;
    case "unreachable":
      return `${machine.name} did not answer.`;
  }
}

/**
 * The distinct values the machines that reported hold, each with the machines that hold it, most common
 * first (this machine's value first on a tie). The popover shows these and a "Use <value> on all machines"
 * action for each.
 */
export function valueGroups(view: SettingsNetworkView, path: string): { value: unknown; machines: SettingsMachineView[] }[] {
  const groups: { key: string; value: unknown; machines: SettingsMachineView[] }[] = [];
  for (const entry of machineValues(view, path)) {
    if (!entry.known) continue;
    const key = JSON.stringify(entry.value ?? null);
    const group = groups.find((candidate) => candidate.key === key);
    if (group) group.machines.push(entry.machine);
    else groups.push({ key, value: entry.value ?? null, machines: [entry.machine] });
  }
  return groups
    .map((group, order) => ({ group, order }))
    .sort((a, b) => b.group.machines.length - a.group.machines.length || a.order - b.order)
    .map(({ group }) => ({ value: group.value, machines: group.machines }));
}

/** "Use <value> on all machines": the `settings.share` call for one field. */
export function useOnAllMachines(path: string, value: unknown): SettingsShareParams {
  return { fields: { [path]: value } };
}

/** The machines a shared change of `path` is still waiting to reach, by name. */
export function pendingMachineNames(view: SettingsNetworkView, path: string): string[] {
  const field = fieldOf(view, path);
  if (!field) return [];
  return view.machines.filter((machine) => field.pending.includes(machine.id)).map((machine) => machine.name);
}

// ---- notes and tasks: sections and the footer ----

const SKIP_WORDS: Record<SkipReason, string> = {
  offline: "offline",
  paused: "paused",
  unsupported: "needs a newer Kybern",
  refused: "has sharing turned off",
  timed_out: "did not answer in time",
  failed: "could not be read",
};

/** "satyamas offline; its notes are not included." for the machines a merged read left out. */
export function federationFooter(federation: Pick<Federation, "skipped"> | null | undefined, noun: "notes" | "tasks"): string | null {
  const skipped = federation?.skipped ?? [];
  if (skipped.length === 0) return null;
  const list = skipped.map((item) => `${item.machine_name} ${SKIP_WORDS[item.reason]}`).join(", ");
  return `${list}; ${skipped.length === 1 ? "its" : "their"} ${noun} are not included.`;
}

/** The footer to show: the daemon's own text, else the one built here. */
export function footerOf(federation: Federation | null | undefined, noun: "notes" | "tasks"): string | null {
  return federation?.footer ?? federationFooter(federation, noun);
}

export interface MachineGroup<T> {
  machineId: MachineId;
  machineName: string;
  isSelf: boolean;
  items: T[];
}

/**
 * Group a merged list by the machine that holds each item, in the order of `federation.sections` (this
 * machine first, then by name). An item no section names (a list that changed since) is left out. Without
 * a federation block the list is one group with no machine.
 */
export function groupByMachine<T>(items: readonly T[], federation: Federation | null | undefined, idOf: (item: T) => string): MachineGroup<T>[] {
  if (!federation) return [{ machineId: "", machineName: "", isSelf: true, items: [...items] }];
  const byId = new Map(items.map((item) => [idOf(item), item] as const));
  return federation.sections.map((section: FederationSection) => ({
    machineId: section.machine_id,
    machineName: section.machine_name,
    isSelf: section.is_self,
    items: section.ids.flatMap((id) => {
      const item = byId.get(id);
      return item === undefined ? [] : [item];
    }),
  }));
}

/** Which machine holds an item, or null when the list was not merged or the id is unknown. */
export function machineOfItem(federation: Federation | null | undefined, id: string): { id: MachineId; name: string; isSelf: boolean } | null {
  const section = federation?.sections.find((candidate) => candidate.ids.includes(id));
  return section ? { id: section.machine_id, name: section.machine_name, isSelf: section.is_self } : null;
}

/**
 * Whether a note or task can be changed from this connection: only on the machine that holds it. A merged
 * list shows other machines' items read-only here; a write goes to a client connected to the owner.
 */
export function isWritableHere(federation: Federation | null | undefined, id: string): boolean {
  const owner = machineOfItem(federation, id);
  return owner === null || owner.isSelf;
}
