// The "All machines" filter (design §5.3) and the connection dot, in place of the
// old computer switcher. Every machine is connected at once, so there is nothing
// to switch: the filter only narrows the lists. It exists once there are two or
// more machines; with one the title shows that computer and its connection.
import { router } from "expo-router";
import { View } from "react-native";
import { setMachineFilter, useMachineFilter } from "../state/machineFilter";
import { connect, useApp, useMachineView } from "../state/runtime";
import { MenuButton } from "../ui/ActionMenu";
import { Brand } from "../ui/Brand";
import type { MenuItem } from "../ui/menuModel";
import { Icon, T, Tap } from "../ui/primitives";
import { radius, space, useTheme } from "../ui/theme";
import { StatusDot } from "./MachineGlyph";
import { connectionLabel } from "./settings/labels";

/** "All machines ✓ / MacBook / satyamas · Offline / Machines…" as menu sections; empty with one machine. */
export function useMachineMenuItems(): MenuItem[] {
  const app = useApp();
  const view = useMachineView();
  const chosen = useMachineFilter();
  if (view.machines.length < 2) return [];
  const offline = app.status === "failed" || app.status === "closed" || app.status === "idle";
  return [
    {
      title: "Show threads from",
      inline: true,
      children: [
        { title: "All machines", checked: chosen === null, onPress: () => setMachineFilter(null) },
        ...view.machines.map<MenuItem>((machine) => ({
          title: machine.name,
          subtitle:
            machine.status === "online" || machine.status === "needs-update"
              ? machine.isLocal ? "Online · this phone is here" : "Online"
              : machine.status === "relaying" ? "Relaying" : machine.status === "paused" ? "Paused" : "Offline",
          checked: chosen === machine.machineId,
          onPress: () => setMachineFilter(machine.machineId),
        })),
      ],
    },
    {
      title: "Machine actions",
      inline: true,
      children: [
        ...(offline && app.activeId ? [{ title: "Reconnect", icon: "arrow.clockwise" as const, onPress: () => connect(app.activeId) }] : []),
        { title: "Add a machine…", icon: "plus", onPress: () => router.push("/machines") },
        { title: "Manage machines…", icon: "laptopcomputer", onPress: () => router.push("/machines") },
      ],
    },
  ];
}

/** The connection as a 7 pt dot: green when connected, amber while connecting, grey otherwise. */
export function ConnectionDot({ status }: { status: string }) {
  const { colors } = useTheme();
  const color =
    status === "open" ? colors.positive : status === "connecting" || status === "reconnecting" ? colors.warning : colors.muted;
  return <View accessible={false} style={{ width: 7, height: 7, borderRadius: radius.full, backgroundColor: color }} />;
}

/**
 * Home's title. One computer: its name and connection, opening Machines. Two or
 * more: the machine filter with a chevron. Before any computer is saved: the wordmark.
 */
export function MachineTitle() {
  const { colors } = useTheme();
  const app = useApp();
  const view = useMachineView();
  const chosen = useMachineFilter();
  const items = useMachineMenuItems();
  const active = app.environments.find((env) => env.id === app.activeId);
  if (!active)
    return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <Brand size={20} />
        <T variant="headline">kybern</T>
      </View>
    );
  const row = (name: string, dot: React.ReactNode, chevron: boolean) => (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 44, paddingHorizontal: space.md }}>
      {dot}
      <T variant="headline" numberOfLines={1} style={{ flexShrink: 1 }}>
        {name}
      </T>
      {chevron ? <Icon name="chevron.down" size={10} color={colors.muted} /> : null}
    </View>
  );
  if (!items.length)
    return (
      <Tap
        label={`Machine: ${active.name}, ${connectionLabel(app.status)}. Open machines`}
        feedback="highlight"
        onPress={() => router.push("/machines")}
        style={{ borderRadius: radius.full, flexShrink: 1 }}
      >
        {row(active.name, <ConnectionDot status={app.status} />, false)}
      </Tap>
    );
  const picked = chosen && view.machines.find((m) => m.machineId === chosen);
  const name = picked ? picked.name : "All machines";
  return (
    <MenuButton items={items} label={`${name}. Filter threads by machine`} radius={radius.full} style={{ flexShrink: 1 }}>
      {row(name, picked ? <StatusDot status={picked.status} /> : <ConnectionDot status={app.status} />, true)}
    </MenuButton>
  );
}
