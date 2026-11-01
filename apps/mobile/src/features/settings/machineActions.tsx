// The actions on one machine, shared by its row's menu on Machines and its detail page. Rows that act through a member are
// built only when the member passes the version gate (ADE-99 §0); the phone-only Disconnect and Forget are never gated.
import { router } from "expo-router";
import type { MachineId } from "../../../../../packages/kybern-client/src/types";
import { MACHINES_COPY } from "../../machines/settingsModel";
import { canManageNetwork, memberParity, pauseOnNetwork, removeFromNetwork } from "../../state/machineActions";
import { connect, errorText, machineHub, removeMachine } from "../../state/runtime";
import { Alert, confirm } from "../../ui/Alert";
import { ListRow } from "../../ui/List";
import type { MenuItem } from "../../ui/menuModel";

export interface MachineRowState {
  id: MachineId;
  name: string;
  member: boolean;
  /** This phone's own connection is to this machine. */
  here: boolean;
  /** The phone disconnected it. */
  disconnected: boolean;
  /** The network paused it. */
  networkPaused: boolean;
  /** Status of the phone's connection to the machine. */
  open: boolean;
  offline: boolean;
}

/** Runs `work`, reporting a failure through `onError`. */
export function useRunner(onError: (message: string) => void) {
  return (work: () => Promise<unknown>) => {
    onError("");
    work().catch((e) => onError(errorText(e)));
  };
}

/** Forget or remove a machine: the sentences and options of the existing Machines screen. */
export function removeMachineFlow(state: Pick<MachineRowState, "id" | "name" | "member">, run: (work: () => Promise<unknown>) => void, done?: () => void) {
  const forget = () => run(async () => { await removeMachine(state.id); done?.(); });
  if (!state.member || !canManageNetwork())
    return confirm({
      title: `Forget “${state.name}”?`,
      message: "This removes the machine from this phone. Its projects and conversations stay on the machine.",
      confirm: "Forget machine",
      onConfirm: forget,
    });
  Alert.alert(`Remove “${state.name}”?`, "Removing it from your network takes it out of every machine's list. Its projects and conversations stay on it.", [
    { text: "Cancel", style: "cancel" },
    { text: "Forget on this phone only", onPress: forget },
    { text: "Remove from your network", style: "destructive", onPress: () => run(async () => { await removeFromNetwork(state.id, false); await removeMachine(state.id); done?.(); }) },
    { text: "Lost or stolen", style: "destructive", onPress: () => run(async () => { await removeFromNetwork(state.id, true); await removeMachine(state.id); done?.(); }) },
  ]);
}

export function pauseFlow(state: Pick<MachineRowState, "id" | "name">, run: (work: () => Promise<unknown>) => void) {
  confirm({
    title: MACHINES_COPY.pauseConfirmTitle(state.name),
    message: MACHINES_COPY.pauseConfirmBody,
    confirm: MACHINES_COPY.pauseConfirmButton,
    destructive: false,
    onConfirm: () => run(() => pauseOnNetwork(state.id, true)),
  });
}

/** The menu of one machine, on its row and on its page. */
export function machineMenu(state: MachineRowState, run: (work: () => Promise<unknown>) => void, options: { activeId: string | null; onDeleted?: () => void }): MenuItem[] {
  const hub = machineHub();
  const gated = state.member && memberParity();
  return [
    ...(state.here
      ? !state.open
        ? [{ title: "Reconnect", icon: "arrow.clockwise" as const, onPress: () => run(async () => { connect(options.activeId); }) }]
        : []
      : [
          ...(!state.disconnected ? [{ title: "Try again", icon: "arrow.clockwise" as const, onPress: () => run(() => hub.retry(state.id)) }] : []),
          state.disconnected
            ? { title: MACHINES_COPY.reconnect, icon: "arrow.right" as const, onPress: () => run(() => hub.setPaused(state.id, false)) }
            : { title: MACHINES_COPY.disconnect, icon: "pause.circle" as const, onPress: () => run(() => hub.setPaused(state.id, true)) },
        ]),
    ...(gated
      ? [
          { title: "Rename…", icon: "pencil" as const, onPress: () => router.push({ pathname: "/machine-rename", params: { id: state.id, name: state.name } }) },
          state.networkPaused
            ? { title: MACHINES_COPY.resume, icon: "arrow.right" as const, onPress: () => run(() => pauseOnNetwork(state.id, false)) }
            : { title: MACHINES_COPY.pause, icon: "pause.circle" as const, onPress: () => pauseFlow(state, run) },
        ]
      : []),
    {
      title: state.member && canManageNetwork() ? "Remove…" : "Forget machine",
      icon: "trash" as const,
      destructive: true,
      onPress: () => removeMachineFlow(state, run, options.onDeleted),
    },
  ];
}

/** The machine page's Actions group: the menu's items as rows. */
export function machineActionRows(state: MachineRowState, options: { activeId: string | null; onDeleted?: () => void }, onError: (message: string) => void) {
  const run = (work: () => Promise<unknown>) => {
    onError("");
    work().catch((e) => onError(errorText(e)));
  };
  return machineMenu(state, run, options).map((item) => (
    <ListRow key={item.title} title={item.title} leading={item.icon} destructive={item.destructive} onPress={item.onPress} />
  ));
}
