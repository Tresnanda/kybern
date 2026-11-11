// The agents a new thread can use on the machine it will run on. The phone's own computer reads `app.providers`; another
// machine's come from that machine (`providers.list` there), so changing the machine chip changes the agent list.
// A machine that is away keeps the list it last answered; one never heard from this launch borrows a live member's
// (`providerSource.ts`), so the composer can still pick agents and models for a send that waits in the outbox (#245).
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { MachineId, ProviderStatus, Thread } from "../../../../packages/kybern-client/src/types";
import { useDraft } from "./draft";
import { useMachineTarget } from "./machineTarget";
import { providerMachine, standInMachine, threadProviderMachine, type ProviderMachine } from "./providerSource";
import { machineHub, useApp, useMachineView, useThreadConnection } from "./runtime";
import { useLists } from "./useLists";
import { useSettingsChoice } from "./machineChoice";

const lists = new Map<MachineId, ProviderStatus[]>();
const loading = new Map<MachineId, Promise<void>>();
const listeners = new Set<() => void>();
let version = 0;
function changed() {
  version++;
  listeners.forEach((fn) => fn());
}
const NONE: ProviderStatus[] = [];

function load(machineId: MachineId, force = false): Promise<void> {
  const running = loading.get(machineId);
  if (running && !force) return running;
  const request = (async () => {
    try {
      const result = await machineHub().clientFor(machineId).call("providers.list", force ? { force_refresh: true } : {});
      lists.set(machineId, result.providers);
      changed();
    } catch {
      // An away machine keeps the list it last answered.
    }
  })().finally(() => {
    if (loading.get(machineId) === request) loading.delete(machineId);
  });
  loading.set(machineId, request);
  return request;
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

/** `machine` is the chosen machine when it is not the phone's own; unset reads the computer the phone is at. */
export function useProviders(machine: ProviderMachine | undefined): ProviderStatus[] {
  const app = useApp();
  const view = useMachineView();
  const primaryId = machineHub().primaryMachineId;
  const seen = useSyncExternalStore(subscribe, () => version, () => version);
  // The computer the phone is at answered this launch: remember its list for when it goes away.
  useEffect(() => {
    if (primaryId && app.providers.length && lists.get(primaryId) !== app.providers) {
      lists.set(primaryId, app.providers);
      changed();
    }
  }, [primaryId, app.providers]);
  useEffect(() => {
    if (machine?.reachable) void load(machine.machineId);
  }, [machine?.machineId, machine?.reachable]);
  const own = machine ? lists.get(machine.machineId) : app.providers.length ? app.providers : primaryId ? lists.get(primaryId) : undefined;
  // An away machine with no known list: a live member's agents stand in until it answers.
  const stand = useMemo(
    () => (machine && !machine.reachable ? standInMachine(view.machines, machine.machineId, !!own?.length) : undefined),
    [own, view, machine?.machineId, machine?.reachable, seen],
  );
  useEffect(() => {
    if (stand && !lists.has(stand)) void load(stand);
  }, [stand]);
  if (own?.length) return own;
  return (stand && lists.get(stand)) || own || NONE;
}

/**
 * The agents of the machine a composer sends to: an open thread's own machine, else the machine Home's next thread runs
 * on (`state/machineTarget.ts`). The model and agent pickers read this, never the paired computer's list alone.
 */
export function useComposerProviders(thread?: Thread | null): ProviderStatus[] {
  const { projects } = useLists();
  const draft = useDraft();
  const project = thread ? undefined : projects.find((p) => p.id === draft.projectId);
  const target = useMachineTarget(project);
  const connection = useThreadConnection(thread?.id);
  const machine: ProviderMachine | undefined = thread ? threadProviderMachine(connection) : providerMachine(target);
  return useProviders(machine);
}

/** The agents of the machine Settings shows (`machineChoice.ts`). */
export function useSettingsProviders(): ProviderStatus[] {
  const choice = useSettingsChoice();
  return useProviders(choice && !choice.primary ? { machineId: choice.machineId, reachable: choice.live } : undefined);
}
