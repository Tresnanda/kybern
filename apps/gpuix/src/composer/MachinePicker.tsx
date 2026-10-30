// The machine chip of a new chat's composer (design §6.1): where the chat runs. Rows in machine order: machines with a checkout
// of the project (an away one says "Offline · sends when it returns"), then the ones without, which offer project setup. It only
// exists while there is a choice (`useMachineTarget().show`), so one machine looks as the composer always did.
import type { ProvisionPlan } from '../../../../packages/kybern-client/src/types.ts'
import { completeProvisionProject } from '../../../../packages/kybern-client/src/provision.ts'
import { glyphOfMachine } from '../machines/index.ts'
import { MachineBadge } from '../sidebar/MachineBadge.tsx'
import { useEffect, useState } from 'react'
import { MachineSetupSheet } from '../provision/MachineSetupSheet.tsx'
import { machineHub } from '../machines/index.ts'
import { Label, useTheme } from '../ui.tsx'
import { PickerChip } from '../kit/PickerChip.tsx'
import { usePaneId, usePaneCompact } from '../state.ts'
import { useFooterFit } from './footerWidth.tsx'
import { CheckMark, PickerItem, PickerMenu } from './Menu.tsx'
import { chooseMachine, type MachineTarget } from './machineTarget.ts'
import { getData, loadMachineLists, patchDraft } from './store.ts'

export function MachinePicker({ target, locked }: { target: MachineTarget; locked?: boolean }) {
  const t = useTheme()
  const paneId = usePaneId()
  const [setup, setSetup] = useState<string | null>(null)
  // Every machine that can be picked has its agents read once the chip shows, so choosing one paints its chips at once.
  const online = target.choices.filter((choice) => choice.selectable && choice.state === 'online' && !choice.isLocal).map((choice) => choice.machineId).join(',')
  useEffect(() => { for (const id of online ? online.split(',') : []) void loadMachineLists(id) }, [online])
  const chosen = target.chosen
  // As the mode chip: the label leaves in a narrow footer or a split pane, the glyph stays.
  const showLabel = useFooterFit().labels && !usePaneCompact()
  const rememberGroupPaths = (plan: ProvisionPlan) => {
    if (!plan.members?.length) return
    const paths = getData(paneId).draft.groupPaths
    const sourcePaths = paths?.[`${target.key}:${plan.source.id}`]
    const inverse = Object.fromEntries(Object.entries(sourcePaths ?? {}).map(([original, source]) => [source, original]))
    patchDraft({ groupPaths: { ...paths, [`${target.key}:${plan.target.id}`]: Object.fromEntries(plan.members.map((member) => [inverse[member.path] ?? member.path, member.target_path])) } }, paneId)
  }
  if (!target.show || !chosen) return null
  return (
    <>
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
            onSelect={() => {
              if (!choice.selectable && target.projectId) setSetup(choice.machineId)
              else if (!checked) chooseMachine(target.key, choice.machineId, paneId)
            }}
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
    {setup && target.projectId && <MachineSetupSheet projectId={target.projectId} targetId={setup} close={() => setSetup(null)} onProvisioned={rememberGroupPaths} onReady={async () => {
      await machineHub().refreshMachineLists(setup)
      const logical = machineHub().view().projects.find((item) => item.key === target.key)
      const destination = logical?.instances.find((item) => item.machineId === setup)
      if (!destination || !completeProvisionProject(chosen.project, destination.project)) throw new Error('The project list has not refreshed yet.')
      if (setup !== machineHub().localMachineId) await loadMachineLists(setup, true, destination.project.id)
      chooseMachine(target.key, setup, paneId)
    }} />}
    </>
  )
}
