// Desktop overlay gallery: the real `components/kit/alert-dialog` and `components/kit/sheet`, composed like
// `NoteMenu` (alert) and the account/environment sheets do. A row of 28px outline triggers at (40, 40) opens
// each one; the right sheet holds a settings select so stacked Escape can be checked.
import type { ComponentType } from 'react'
import {
  AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup,
  AlertDialogTitle, AlertDialogTrigger,
} from '@/components/kit/alert-dialog'
import { Button } from '@/components/kit/button'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '@/components/kit/select'
import {
  Sheet, SheetClose, SheetDescription, SheetFooter, SheetHeader, SheetPanel, SheetPopup, SheetTitle, SheetTrigger,
} from '@/components/kit/sheet'

const regions = [
  { value: 'local', label: 'This Mac' },
  { value: 'worktree', label: 'New worktree' },
  { value: 'remote', label: 'Remote host' },
]

function SheetBody({ side }: { side: string }) {
  return (
    <>
      <SheetHeader>
        <SheetTitle>Environment</SheetTitle>
        <SheetDescription>Choose where new threads in this project run.</SheetDescription>
      </SheetHeader>
      <SheetPanel>
        <div className="flex flex-col gap-3">
          <p className="text-sm">Threads keep their environment after they start. Changing it here affects new threads only.</p>
          <Select items={regions} defaultValue="local">
            <SelectTrigger className="w-[200px]" data-testid={`sheet-${side}-select-trigger`}><SelectValue /></SelectTrigger>
            <SelectPopup surface="settings" data-testid={`sheet-${side}-select-popup`}>
              {regions.map((r) => <SelectItem key={r.value} value={r.value} data-testid={`sheet-${side}-select-option-${r.value}`}>{r.label}</SelectItem>)}
            </SelectPopup>
          </Select>
        </div>
      </SheetPanel>
      <SheetFooter>
        <SheetClose render={<Button variant="outline" data-testid={`sheet-${side}-cancel`} />}>Cancel</SheetClose>
        <SheetClose render={<Button data-testid={`sheet-${side}-save`} />}>Save</SheetClose>
      </SheetFooter>
    </>
  )
}

function OverlaysDemo() {
  return (
    <div style={{ position: 'absolute', left: 40, top: 40, display: 'flex', gap: 8 }}>
      <AlertDialog>
        <AlertDialogTrigger render={<Button variant="outline" data-testid="alert-trigger" />}>Delete note</AlertDialogTrigger>
        <AlertDialogPopup data-testid="alert-popup">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this note forever?</AlertDialogTitle>
            <AlertDialogDescription>“Project brief” will be removed for good. You can’t undo this.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" data-testid="alert-cancel" />}>Cancel</AlertDialogClose>
            <AlertDialogClose render={<Button variant="destructive" data-testid="alert-confirm" />}>Delete forever</AlertDialogClose>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      {(['right', 'left', 'top', 'bottom'] as const).map((side) => (
        <Sheet key={side}>
          <SheetTrigger render={<Button variant="outline" data-testid={`sheet-${side}-trigger`} />}>{`Sheet ${side}`}</SheetTrigger>
          <SheetPopup side={side} data-testid={`sheet-${side}-popup`}><SheetBody side={side} /></SheetPopup>
        </Sheet>
      ))}
      <Sheet>
        <SheetTrigger render={<Button variant="outline" data-testid="sheet-inset-trigger" />}>Inset sheet</SheetTrigger>
        <SheetPopup side="right" variant="inset" data-testid="sheet-inset-popup"><SheetBody side="inset" /></SheetPopup>
      </Sheet>
    </div>
  )
}

export const sections: Record<string, ComponentType> = { overlays: OverlaysDemo }
