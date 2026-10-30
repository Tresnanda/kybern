// The machine chip of a new chat's composer (design §6.1): where the chat runs. Rows in machine order: machines with a checkout
// of the project (an away one says "Offline · sends when it returns"), then the ones without, disabled with the reason. It only
// exists while there is a choice (`useMachineTarget().show`), so one machine looks as the composer always did.
import { glyphOfMachine } from '../machines/index.ts'
import { MachineBadge } from '../sidebar/MachineBadge.tsx'
import { useEffect } from 'react'
import { Label, useTheme } from '../ui.tsx'
import { PickerChip } from '../kit/PickerChip.tsx'
import { usePaneCompact } from '../state.ts'
import { useFooterFit } from './footerWidth.tsx'
import { CheckMark, PickerItem, PickerMenu } from './Menu.tsx'
import { chooseMachine, type MachineTarget } from './machineTarget.ts'
import { loadMachineLists } from './store.ts'

export function MachinePicker({ target, locked }: { target: MachineTarget; locked?: boolean }) {
  const t = useTheme()
  // Every machine that can be picked has its agents read once the chip shows, so choosing one paints its chips at once.
  const online = target.choices.filter((choice) => choice.selectable && choice.state === 'online' && !choice.isLocal).map((choice) => choice.machineId).join(',')
  useEffect(() => { for (const id of online ? online.split(',') : []) void loadMachineLists(id) }, [online])
  const chosen = target.chosen
  // As the mode chip: the label leaves in a narrow footer or a split pane, the glyph stays.
  const showLabel = useFooterFit().labels && !usePaneCompact()
  if (!target.show || !chosen) return null
  return (
    <PickerMenu
      testId="machine-picker"
      side="top"
      align="end"
      width={304}
      padding={6}
      gap={2}
      disabled={locked}
      trigger={(open) => (
        <PickerChip bare truncate open={open} chevron={showLabel} label={`Run on ${chosen.name}`} lead={<MachineBadge glyph={glyphOfMachine(chosen.machineId)} size={16} />}>
          {showLabel ? <Label color={t.text} size={13} lineHeight={18} weight={500} truncate>{chosen.name}</Label> : null}
        </PickerChip>
      )}
    >
      {target.choices.map((choice) => {
        const checked = choice.machineId === chosen.machineId
        return (
          <PickerItem
            key={choice.machineId}
            id={choice.machineId}
            testId={`machine-${choice.machineId}`}
            disabled={!choice.selectable}
            onSelect={() => { if (!checked) chooseMachine(target.key, choice.machineId) }}
            style={{ minHeight: 40, paddingLeft: 10, paddingRight: 10, paddingTop: 4, paddingBottom: 4 }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexGrow: 1, minWidth: 0 }}>
              <MachineBadge glyph={glyphOfMachine(choice.machineId)} size={18} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0, flexShrink: 1 }}>
                <Label color={t.text} weight={500} lineHeight={17.5} truncate>{choice.isLocal ? `${choice.name} (this computer)` : choice.name}</Label>
                <Label color={choice.state === 'online' ? t.textSecondary : t.textSecondary} size={12} lineHeight={16} truncate>{choice.detail}</Label>
              </div>
            </div>
            <CheckMark color={t.text} visible={checked} />
          </PickerItem>
        )
      })}
    </PickerMenu>
  )
}
