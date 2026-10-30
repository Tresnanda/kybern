// The agents a new thread can use on the machine it will run on. The phone's own computer reads `app.providers`; another
// machine's come from that machine (`providers.list` there), so changing the machine chip changes the agent list.
import { useEffect, useSyncExternalStore } from "react";
import type { MachineId, ProviderStatus } from "../../../../packages/kybern-client/src/types";
import { machineHub, useApp } from "./runtime";

const lists = new Map<MachineId, ProviderStatus[]>();
const loading = new Map<MachineId, Promise<void>>();
const listeners = new Set<() => void>();
const NONE: ProviderStatus[] = [];

function load(machineId: MachineId, force = false): Promise<void> {
  const running = loading.get(machineId);
  if (running && !force) return running;
  const request = (async () => {
    try {
      const result = await machineHub().clientFor(machineId).call("providers.list", force ? { force_refresh: true } : {});
      lists.set(machineId, result.providers);
      listeners.forEach((fn) => fn());
    } catch {
      // An away machine keeps the list it last answered.
    }
  })().finally(() => {
    if (loading.get(machineId) === request) loading.delete(machineId);
  });
  loading.set(machineId, request);
  return request;
}

/** `machine` is the chosen machine when it is not the phone's own; unset reads the computer the phone is at. */
export function useProviders(machine: { machineId: MachineId; reachable: boolean } | undefined): ProviderStatus[] {
  const app = useApp();
  const remote = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    () => (machine ? lists.get(machine.machineId) ?? NONE : NONE),
    () => NONE,
  );
  useEffect(() => {
    if (machine?.reachable) void load(machine.machineId);
  }, [machine?.machineId, machine?.reachable]);
  return machine ? remote : app.providers;
}
