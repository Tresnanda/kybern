// GPUIX twin of `visual/kit/sections/overlays.tsx`: the alert dialog and the four sheets (plus inset) behind a
// row of outline triggers at (40, 40); the right sheet holds a settings select for the stacked Escape check.
import { useState, type ComponentType } from 'react'
import { useTheme, Label } from '../../ui.tsx'
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../AlertDialog.tsx'
import { Button } from '../Button.tsx'
import { Select } from '../Select.tsx'
import { Sheet, SheetClose, SheetDescription, SheetFooter, SheetHeader, SheetPanel, SheetTitle, type SheetSide } from '../Sheet.tsx'
import { osLabels } from '../../platform/os.ts'

const regions = [
  { value: 'local', label: osLabels().thisComputer },
  { value: 'worktree', label: 'New worktree' },
  { value: 'remote', label: 'Remote host' },
]

function SheetBody({ id }: { id: string }) {
  const t = useTheme()
  return (
    <>
      <SheetHeader>
        <SheetTitle>Environment</SheetTitle>
        <SheetDescription>Choose where new threads in this project run.</SheetDescription>
      </SheetHeader>
      <SheetPanel>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'flex-start' }}>
          <Label color={t.text} size={14} lineHeight={20}>Threads keep their environment after they start. Changing it here affects new threads only.</Label>
          <Select options={regions} defaultValue="local" width={200} testId={`sheet-${id}-select`} label="Environment" />
        </div>
      </SheetPanel>
      <SheetFooter>
        <SheetClose variant="secondary" testId={`sheet-${id}-cancel`}>Cancel</SheetClose>
        <SheetClose variant="primary" testId={`sheet-${id}-save`}>Save</SheetClose>
      </SheetFooter>
    </>
  )
}

function OverlaysDemo() {
  const [alert, setAlert] = useState(false)
  const [sheet, setSheet] = useState<string | null>(null)
  const sides: SheetSide[] = ['right', 'left', 'top', 'bottom']
  return (
    <div style={{ position: 'absolute', left: 40, top: 40, display: 'flex', gap: 8 }}>
      <Button testId="alert-trigger" onClick={() => setAlert(true)}>Delete note</Button>
      {sides.map((side) => <Button key={side} testId={`sheet-${side}-trigger`} onClick={() => setSheet(side)}>{`Sheet ${side}`}</Button>)}
      <Button testId="sheet-inset-trigger" onClick={() => setSheet('inset')}>Inset sheet</Button>
      <AlertDialog open={alert} onOpenChange={setAlert} testId="alert-popup">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this note forever?</AlertDialogTitle>
          <AlertDialogDescription>“Project brief” will be removed for good. You can’t undo this.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose variant="secondary" testId="alert-cancel">Cancel</AlertDialogClose>
          <AlertDialogClose variant="destructive" testId="alert-confirm">Delete forever</AlertDialogClose>
        </AlertDialogFooter>
      </AlertDialog>
      {sides.map((side) => (
        <Sheet key={side} side={side} open={sheet === side} onOpenChange={(o) => setSheet(o ? side : null)} testId={`sheet-${side}-popup`}>
          <SheetBody id={side} />
        </Sheet>
      ))}
      <Sheet side="right" variant="inset" open={sheet === 'inset'} onOpenChange={(o) => setSheet(o ? 'inset' : null)} testId="sheet-inset-popup">
        <SheetBody id="inset" />
      </Sheet>
    </div>
  )
}

export const sections: Record<string, ComponentType> = { overlays: OverlaysDemo }
