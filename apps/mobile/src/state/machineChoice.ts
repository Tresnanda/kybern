// The machine a machine-scoped screen works on (rules in `machineChoiceModel.ts`). Settings keeps one pick for the
// session, read by the settings, accounts and computer-use stores; Add project and Import sessions keep their own
// pick per visit. With one machine nothing here shows and everything stays on the computer the phone is at.
import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import type { KybernClient } from "../../../../packages/kybern-client/src/client";
import type { MachineId, MethodName, ParamsOf, ResultOf } from "../../../../packages/kybern-client/src/types";
import { isLiveStatus, resolveChoice, type ResolvedChoice } from "./machineChoiceModel";
import { currentClient, getState, machineHub, onClientAttach, rpc, subscribeApp } from "./runtime";

export type { ResolvedChoice };

/** The resolved machine for a pick; undefined with one machine (the computer the phone is at). */
export function choiceFor(picked: MachineId | null | undefined): ResolvedChoice | undefined {
  const hub = machineHub();
  const machines = hub.view().machines;
  if (machines.length < 2) return undefined;
  return resolveChoice({ picked, machines, primaryId: hub.primaryMachineId, primaryOpen: getState().status === "open" });
}

/** The machine id to pass to `rpc`: undefined is the computer the phone is at. */
export const choiceTarget = (choice: ResolvedChoice | undefined): MachineId | undefined =>
  choice && !choice.primary ? choice.machineId : undefined;

/** The client of a resolved machine, or null while it can't be reached. */
export function choiceClient(choice: ResolvedChoice | undefined): KybernClient | null {
  if (!choice || choice.primary) return currentClient() ?? null;
  try {
    return machineHub().clientFor(choice.machineId);
  } catch {
    return null;
  }
}

/** A request to the chosen machine. */
export function choiceRpc<M extends MethodName>(choice: ResolvedChoice | undefined, method: M, params: ParamsOf<M>): Promise<ResultOf<M>> {
  return rpc(method, params, choiceTarget(choice));
}

const key = (choice: ResolvedChoice | undefined) => (choice ? `${choice.machineId}:${choice.live}` : "");

function subscribeAll(fn: () => void) {
  const offHub = machineHub().subscribe(fn);
  const offApp = subscribeApp(fn);
  return () => {
    offHub();
    offApp();
  };
}

/** The menu of machines to pick from: live ones, then away ones (disabled). */
export function choiceMenu(current: ResolvedChoice | undefined, pick: (id: MachineId) => void) {
  const hub = machineHub();
  const primaryOpen = getState().status === "open";
  return hub.view().machines.map((m) => {
    const live = m.machineId === hub.primaryMachineId ? primaryOpen : isLiveStatus(m.status);
    return {
      title: m.name,
      checked: m.machineId === current?.machineId,
      disabled: !live,
      ...(live ? {} : { subtitle: "Offline" }),
      onPress: () => pick(m.machineId),
    };
  });
}

/** A screen's own pick: starts on the computer the phone is at (or a live member while it is away). */
export function useMachineChoice(): { choice: ResolvedChoice | undefined; pick: (id: MachineId) => void } {
  const [picked, setPicked] = useState<MachineId | null>(null);
  const last = useRef<ResolvedChoice | undefined>(undefined);
  const read = useCallback(() => {
    const next = choiceFor(picked);
    if (key(next) !== key(last.current)) last.current = next;
    return last.current;
  }, [picked]);
  const choice = useSyncExternalStore(subscribeAll, read, read);
  return { choice, pick: setPicked };
}

// ---- Settings: one pick, read by the stores ----

let settingsPicked: MachineId | null = null;
let settingsResolved: ResolvedChoice | undefined;
const settingsListeners = new Set<() => void>();
let watching = false;

function recheck() {
  const next = choiceFor(settingsPicked);
  if (key(next) === key(settingsResolved)) return;
  const moved = next?.machineId !== settingsResolved?.machineId;
  settingsResolved = next;
  settingsListeners.forEach((fn) => fn());
  if (moved) machineChangeHooks.forEach((fn) => fn());
}
function watch() {
  if (watching) return;
  watching = true;
  subscribeAll(recheck);
  recheck();
}
onClientAttach(() => watch());

/** The machine Settings shows. */
export function settingsChoice(): ResolvedChoice | undefined {
  if (!watching) settingsResolved = choiceFor(settingsPicked);
  return settingsResolved;
}
/** The client the settings stores read and write through: the computer the phone is at unless Settings shows another. */
export function settingsClient(): KybernClient | null {
  return choiceClient(settingsChoice());
}
export function pickSettingsMachine(id: MachineId) {
  settingsPicked = id;
  recheck();
}
const machineChangeHooks = new Set<() => void>();
/** Settings moved to another machine: the stores read again. */
export function onSettingsMachineChange(fn: () => void) {
  machineChangeHooks.add(fn);
  return () => {
    machineChangeHooks.delete(fn);
  };
}
export function useSettingsChoice(): ResolvedChoice | undefined {
  return useSyncExternalStore(
    (fn) => {
      watch();
      settingsListeners.add(fn);
      return () => {
        settingsListeners.delete(fn);
      };
    },
    settingsChoice,
    settingsChoice,
  );
}

/** Settings' machine answers now (with one machine: the computer the phone is at). */
export function useSettingsLive(): boolean {
  const choice = useSettingsChoice();
  const status = useSyncExternalStore(subscribeApp, () => getState().status, () => getState().status);
  return choice ? choice.live : status === "open";
}

/** `rpc` to the machine Settings shows. */
export function settingsRpc<M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>> {
  return choiceRpc(settingsChoice(), method, params);
}
