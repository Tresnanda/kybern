import { useMemo, useSyncExternalStore } from "react";
import { getSpacePlacementVersion, subscribeSpacePlacements } from "../../../../packages/kybern-client/src/spacePlacements";
import type { MachineId } from "../../../../packages/kybern-client/src/types";
import { useMachineFilter } from "./machineFilter";
import type { ListsView } from "./machineLists";
import { listsOf, useApp, useMachineView } from "./runtime";

/**
 * The projects, threads and activity the list screens show: every machine's,
 * merged, or one machine's when the filter names it. With one machine this is
 * the computer's own lists, unchanged.
 */
export function useLists(machine?: MachineId | null): ListsView {
  const placementVersion = useSyncExternalStore(subscribeSpacePlacements, getSpacePlacementVersion, getSpacePlacementVersion);
  const app = useApp();
  const view = useMachineView();
  const chosen = useMachineFilter();
  const filter = machine === undefined ? chosen : machine;
  return useMemo(
    () => listsOf(view, filter),
    // `listsOf` reads the computer's lists from the runtime; they change with `app`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view, filter, app.projects, app.threads, app.activity, placementVersion],
  );
}
