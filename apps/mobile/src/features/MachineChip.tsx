// The composer's machine chip (design §6.1): where the new thread runs. Machines that have a checkout of the project can
// be chosen, an away one says "Offline · sends when it returns"; the rest are disabled with the reason. It only shows
// while there is a choice, so one computer looks as Home always did.
import { router } from "expo-router";
import { View } from "react-native";
import { machineGlyph } from "../../../../packages/kybern-client/src/machineMerge";
import type { MachineTarget } from "../state/machineTarget";
import { pickMachine } from "../state/machineTarget";
import { MenuButton } from "../ui/ActionMenu";
import { Icon, T } from "../ui/primitives";
import { radius, space, useTheme } from "../ui/theme";
import { machineParity } from "../state/machineActions";
import { noCheckoutText } from "../state/threadMachineModel";
import { MachineGlyph } from "./MachineGlyph";

export function MachineChip({ target }: { target: MachineTarget }) {
  const { colors } = useTheme();
  const chosen = target.chosen;
  if (!target.show || !chosen) return null;
  // A machine without the project is disabled with the reason; where another machine can send it, "Set up project" follows (§2.3).
  const sender = target.choices.find((c) => c.selectable && c.projectId && c.state === "online") ?? target.choices.find((c) => c.selectable && c.projectId);
  const setup =
    sender?.projectId && machineParity(sender.machineId)
      ? target.choices
          .filter((c) => c.state === "no-checkout" && machineParity(c.machineId))
          .map((c) => ({
            title: `Set up project on ${c.name}`,
            icon: "folder.badge.plus" as const,
            onPress: () => router.push({ pathname: "/setup-project", params: { source: sender.machineId, projectId: sender.projectId!, target: c.machineId } }),
          }))
      : [];
  return (
    <MenuButton
      label={`Run on ${chosen.name}. Choose a machine`}
      radius={radius.full}
      items={[
        ...target.choices.map((choice) => ({
          title: choice.isLocal ? `${choice.name} (this phone is here)` : choice.name,
          subtitle: choice.state === "no-checkout" ? noCheckoutText(choice.name) : choice.detail,
          disabled: !choice.selectable,
          checked: choice.machineId === chosen.machineId,
          onPress: () => pickMachine(target.key, choice.machineId),
        })),
        ...setup,
      ]}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 36, paddingHorizontal: space.sm }}>
        <MachineGlyph glyph={machineGlyph({ machineId: chosen.machineId, name: chosen.name })} size={16} />
        <T variant="footnote" tone="secondary" numberOfLines={1} style={{ flexShrink: 1 }}>
          {chosen.name}
        </T>
        <Icon name="chevron.down" size={9} color={colors.muted} />
      </View>
    </MenuButton>
  );
}
