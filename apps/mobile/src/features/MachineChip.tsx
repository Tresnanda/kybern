// The composer's machine chip (design §6.1): where the new thread runs. One row per machine: a machine with a checkout of
// the project can be chosen (an away one says "Offline · sends when it returns"); one without it reads "No checkout · Set
// up project" and leads into setting it up (§2.3), or is disabled with the reason. It only shows while there is a choice,
// so one computer looks as Home always did. The chip shrinks with the row: the machine's name truncates, never overlaps.
import { router } from "expo-router";
import { View } from "react-native";
import { shortMachineName } from "../../../../packages/kybern-client/src/forkMachine";
import { machineGlyph } from "../../../../packages/kybern-client/src/machineMerge";
import { machineReachable } from "../../../../packages/kybern-client/src/machineTarget";
import type { MachineTarget } from "../state/machineTarget";
import { pickMachine } from "../state/machineTarget";
import { MenuButton } from "../ui/ActionMenu";
import { Icon, T } from "../ui/primitives";
import { radius, space, useTheme } from "../ui/theme";
import { machineParity } from "../state/machineActions";
import { useMachineView } from "../state/runtime";
import { machineMenuRows } from "../state/threadMachineModel";
import { MachineGlyph } from "./MachineGlyph";

export function MachineChip({ target }: { target: MachineTarget }) {
  const { colors } = useTheme();
  const view = useMachineView();
  const chosen = target.chosen;
  if (!target.show || !chosen) return null;
  // The machine that sends the project to one without it: an online one with a checkout.
  const sender = target.choices.find((c) => c.selectable && c.projectId && c.state === "online");
  const rows = machineMenuRows({
    choices: target.choices,
    chosen: chosen.machineId,
    online: (id) => machineReachable(view.machines.find((m) => m.machineId === id)?.status ?? "offline"),
    canSetUp: (id) => !!sender?.projectId && machineParity(sender.machineId) && machineParity(id),
  });
  return (
    <MenuButton
      label={`Run on ${chosen.name}. Choose a machine`}
      radius={radius.full}
      // The machine gives way before the project: its glyph still says which machine it is.
      style={{ flexShrink: 4, minWidth: 0 }}
      items={rows.map((row) => ({
        title: row.title,
        subtitle: row.subtitle,
        disabled: row.disabled,
        checked: row.checked,
        ...(row.action === "setup" ? { icon: "folder.badge.plus" as const } : {}),
        onPress: () => {
          if (row.action === "pick") pickMachine(target.key, row.machineId);
          else if (row.action === "setup" && sender?.projectId)
            router.push({ pathname: "/setup-project", params: { source: sender.machineId, projectId: sender.projectId, target: row.machineId } });
        },
      }))}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 36, paddingHorizontal: space.sm, minWidth: 0 }}>
        <MachineGlyph glyph={machineGlyph({ machineId: chosen.machineId, name: chosen.name })} size={16} />
        <T variant="footnote" tone="secondary" numberOfLines={1} style={{ flexShrink: 1 }}>
          {shortMachineName(chosen.name)}
        </T>
        <Icon name="chevron.down" size={9} color={colors.muted} />
      </View>
    </MenuButton>
  );
}
