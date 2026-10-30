// The "All machines" filter of the Threads, Home and sidebar lists: null shows
// every machine, an id shows that machine only. Kept while the app runs.
import { useSyncExternalStore } from "react";
import type { MachineId } from "../../../../packages/kybern-client/src/types";

let current: MachineId | null = null;
const listeners = new Set<() => void>();

export const machineFilter = () => current;
export function setMachineFilter(machineId: MachineId | null) {
  if (current === machineId) return;
  current = machineId;
  listeners.forEach((fn) => fn());
}
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
export const useMachineFilter = () => useSyncExternalStore(subscribe, machineFilter, machineFilter);
