// The machines a fork or a move can go to (ADE-99 §2.2): one row per machine. A machine with the project is a choice; one
// without it reads "No checkout · Set up project" and leads into setting it up (§2.3), or says why it cannot.
import { InsetGroup, ListRow } from "../ui/List";
import type { SheetTarget } from "../state/threadMachineModel";
import { useMachineView } from "../state/runtime";
import { MachineGlyph } from "./MachineGlyph";

export function MachinePickerRows({
  targets,
  selected,
  onSelect,
  onSetup,
  disabled,
}: {
  targets: readonly SheetTarget[];
  selected: string | undefined;
  onSelect: (machineId: string) => void;
  /** Opens Set up project for a row that offers it (`canSetUp`). */
  onSetup?: (target: SheetTarget) => void;
  disabled?: boolean;
}) {
  const view = useMachineView();
  return (
    <InsetGroup>
      {targets.map((target) => {
        const glyph = view.machines.find((m) => m.machineId === target.machineId)?.glyph;
        const setUp = target.missing && target.canSetUp && onSetup ? () => onSetup(target) : undefined;
        return (
          <ListRow
            key={target.machineId}
            title={target.machineName}
            subtitle={target.detail}
            subtitleLines={2}
            leading={glyph ? <MachineGlyph glyph={glyph} size={24} /> : "laptopcomputer"}
            checked={!target.missing && target.machineId === selected}
            disabled={disabled || (target.missing && !setUp)}
            dimmed={target.missing ? !setUp : !target.online}
            chevron={!!setUp}
            label={target.missing ? `${target.machineName}. ${target.detail}` : target.machineName}
            onPress={target.missing ? setUp : () => onSelect(target.machineId)}
          />
        );
      })}
    </InsetGroup>
  );
}
