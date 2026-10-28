// Where Home's next new thread runs (design §6.1, Q35), on the phone. The rules are the shared ones
// (`packages/kybern-client/src/machineTarget.ts`): the last machine used for the project, else the machine the phone is at
// (the paired member). With one machine nothing here shows. The pick is kept across launches, per logical project.
import { File, Paths } from "expo-file-system";
import { useMemo, useSyncExternalStore } from "react";
import { Platform } from "react-native";
import {
  machineChoices,
  machineMemoryKey,
  resolveMachine,
  showMachinePicker,
  type MachineChoice,
} from "../../../../packages/kybern-client/src/machineTarget";
import { isFreeChatProject, type MachineId, type Project } from "../../../../packages/kybern-client/src/types";
import { useMachineView } from "./runtime";

export interface MachineTarget {
  /** Show the chip: there is a real choice. */
  show: boolean;
  choices: readonly MachineChoice[];
  chosen?: MachineChoice;
  /** The chat is made on another machine (even without a chip: a project only that machine has). */
  remote: boolean;
  /** The chosen machine answers now; if not, the send waits in the outbox. */
  reachable: boolean;
  key: string;
}

const SOLO: MachineTarget = Object.freeze({ show: false, choices: [], remote: false, reachable: true, key: "free" });

// ---- the picks, by logical project ----

type Picks = Record<string, MachineId>;
const file = () => new File(Paths.document, "kybern-machine-picks.json");
function readPicks(): Picks {
  if (Platform.OS === "web") return {};
  try {
    const f = file();
    if (!f.exists) return {};
    const value = JSON.parse(f.textSync()) as unknown;
    return value && typeof value === "object" ? (value as Picks) : {};
  } catch {
    return {};
  }
}
let picks: Picks = readPicks();
const listeners = new Set<() => void>();
let writeTimer: ReturnType<typeof setTimeout> | undefined;

/** Pick (and so remember) the machine for a project's next threads. */
export function pickMachine(key: string, machineId: MachineId) {
  if (picks[key] === machineId) return;
  picks = { ...picks, [key]: machineId };
  listeners.forEach((fn) => fn());
  if (Platform.OS === "web") return;
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    try {
      const f = file();
      if (!f.exists) f.create();
      f.write(JSON.stringify(picks));
    } catch {
      // The pick is a convenience; the next change writes it again.
    }
  }, 400);
}
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
const readSnapshot = () => picks;

/** `project` is the listed project (the paired machine's when it has one). */
export function useMachineTarget(project: Project | undefined): MachineTarget {
  const view = useMachineView();
  const picked = useSyncExternalStore(subscribe, readSnapshot, readSnapshot);
  return useMemo(() => {
    if (view.machines.length < 2) return SOLO;
    const isFree = !project || isFreeChatProject(project.id);
    const logical = isFree ? null : view.projects.find((item) => item.instances.some((i) => i.project.id === project.id)) ?? null;
    // A project the merged view does not know yet must not read as a free chat.
    if (!isFree && !logical) return SOLO;
    const choices = machineChoices({ machines: view.machines, project: logical });
    const key = machineMemoryKey(logical);
    const chosen = resolveMachine(choices, picked[key], picked[key]);
    if (!chosen) return { ...SOLO, key };
    return { show: showMachinePicker(choices, logical), choices, chosen, remote: !chosen.isLocal, reachable: chosen.state === "online", key };
  }, [view, project?.id, picked]);
}
