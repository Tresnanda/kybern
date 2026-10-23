// Closing a file tab with unsaved edits (ADE-61) asks first: Save, Don't save, or Cancel. One dialog for the window (App.tsx);
// `closeTabAction` raises it (`closeDirtyRequest.ts`) instead of closing.
import { useState } from 'react'
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../kit/AlertDialog.tsx'
import { discardBuffer, getBuffer, saveBuffer } from '../dock/fileBuffers.ts'
import { closeTab } from '../split/store.ts'
import { requestCloseDirty, useCloseDirtyRequest, type CloseDirtyRequest as Pending } from './closeDirtyRequest.ts'

const set = requestCloseDirty

export function CloseDirtyDialog() {
  const request = useCloseDirtyRequest()
  // The dialog keeps its words while it fades out.
  const [shown, setShown] = useState<Pending | null>(null)
  if (request && request !== shown) setShown(request)
  const current = request ?? shown
  if (!current) return null
  const close = () => closeTab(current.leafId, current.key)
  return (
    <AlertDialog open={!!request} onOpenChange={(open) => { if (!open) set(null) }} width={448} testId="close-dirty">
      <AlertDialogHeader>
        <AlertDialogTitle>{`Save changes to ${current.name}?`}</AlertDialogTitle>
        <AlertDialogDescription>Your edits are lost if you close without saving.</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <div style={{ display: 'flex', flexGrow: 1 }}>
          <AlertDialogClose variant="destructive-outline" testId="close-dirty-discard" onClick={() => { discardBuffer(current.buffer); close() }}>Don't save</AlertDialogClose>
        </div>
        <AlertDialogClose variant="outline" testId="close-dirty-cancel">Cancel</AlertDialogClose>
        <AlertDialogClose variant="primary" testId="close-dirty-save" onClick={() => {
          void saveBuffer(current.buffer).then((saved) => { if (saved && !getBuffer(current.buffer)?.dirty) close() })
        }}>Save</AlertDialogClose>
      </AlertDialogFooter>
    </AlertDialog>
  )
}
