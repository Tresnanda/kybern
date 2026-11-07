import { useSyncExternalStore } from "react";
import { UpdateRunStore } from "../../../../packages/kybern-client/src/updateRun";
import { isNetworkStatus } from "../../../../packages/kybern-client/src/machines";
import type { ListCacheStorage } from "../state/listCache";
let storage: ListCacheStorage | undefined;
export const updateRuns = new UpdateRunStore(async value => { await storage?.write(value); });
export function initializeUpdateStorage(value: ListCacheStorage) {
  storage = value;
  Promise.resolve(value.read()).then(saved => updateRuns.hydrate(saved)).catch(() => {});
}
export const useUpdateRun = () => useSyncExternalStore(updateRuns.subscribe, updateRuns.get);
export function receiveUpdateStatus(value: unknown) {
  if (isNetworkStatus(value)) updateRuns.reconcile(value.members);
}
