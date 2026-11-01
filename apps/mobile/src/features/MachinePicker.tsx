// The machines a fork or a move can go to (ADE-99 §2.2): a machine with the project is a choice; one without it is disabled with
// "No checkout on <machine>" and offers Set up project (§2.3). Used by the fork and continue sheet.
import { InsetGroup, ListRow } from "../ui/List";
import { Button } from "../ui/primitives";
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
  /** Present when the project can be set up from here; absent hides the button. */
  onSetup?: (target: SheetTarget) => void;
  disabled?: boolean;
}) {
  const view = useMachineView();
  return (
    <InsetGroup>
      {targets.map((target) => {
        const glyph = view.machines.find((m) => m.machineId === target.machineId)?.glyph;
        return (
          <ListRow
            key={target.machineId}
            title={target.machineName}
            subtitle={target.detail}
            subtitleLines={2}
            leading={glyph ? <MachineGlyph glyph={glyph} size={24} /> : "laptopcomputer"}
            checked={!target.missing && target.machineId === selected}
            disabled={disabled}
            dimmed={!target.missing && !target.online}
            label={target.missing ? `${target.machineName}. ${target.detail}` : target.machineName}
            onPress={target.missing ? undefined : () => onSelect(target.machineId)}
            trailing={
              target.missing && onSetup && target.online ? (
                <Button size="medium" role="plain" label={`Set up project on ${target.machineName}`} disabled={disabled} onPress={() => onSetup(target)}>
                  Set up project
                </Button>
              ) : undefined
            }
          />
        );
      })}
    </InsetGroup>
  );
}
