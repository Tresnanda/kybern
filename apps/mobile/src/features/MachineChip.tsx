// The composer's machine chip (design §6.1): where the new thread runs. Machines that have a checkout of the project can
// be chosen, an away one says "Offline · sends when it returns"; the rest are disabled with the reason. It only shows
// while there is a choice, so one computer looks as Home always did.
import { View } from "react-native";
import { machineGlyph } from "../../../../packages/kybern-client/src/machineMerge";
import type { MachineTarget } from "../state/machineTarget";
import { pickMachine } from "../state/machineTarget";
import { MenuButton } from "../ui/ActionMenu";
import { Icon, T } from "../ui/primitives";
import { radius, space, useTheme } from "../ui/theme";
import { MachineGlyph } from "./MachineGlyph";

export function MachineChip({ target }: { target: MachineTarget }) {
  const { colors } = useTheme();
  const chosen = target.chosen;
  if (!target.show || !chosen) return null;
  return (
    <MenuButton
      label={`Run on ${chosen.name}. Choose a machine`}
      radius={radius.full}
      items={target.choices.map((choice) => ({
        title: choice.isLocal ? `${choice.name} (this phone is here)` : choice.name,
        subtitle: choice.detail,
        disabled: !choice.selectable,
        checked: choice.machineId === chosen.machineId,
        onPress: () => pickMachine(target.key, choice.machineId),
      }))}
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
