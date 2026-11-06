// "Open <path> read-only?" for a link to a file outside the thread's workspace (`outsideFile.ts`). One dialog for the window.
import { useState } from 'react'
import { AlertDialog, AlertDialogClose, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../kit/AlertDialog.tsx'
import { outsideChoices, useOutsideRequest, type OutsideChoice, type OutsideRequest } from './outsideFile.ts'

const LABEL: Record<OutsideChoice, string> = { once: 'Open once', folder: 'Always allow this folder' }

export function OutsideFileDialog() {
  const request = useOutsideRequest()
  // The dialog keeps its words while it fades out.
  const [shown, setShown] = useState<OutsideRequest | null>(null)
  if (request && request !== shown) setShown(request)
  const current = request ?? shown
  if (!current) return null
  const [first, second] = outsideChoices(current)
  const choose = (choice: OutsideChoice) => () => current.answer(choice)
  return (
    <AlertDialog open={!!request} onOpenChange={(open) => { if (!open) current.answer(null) }} width={448} testId="outside-file">
      <AlertDialogHeader>
        <AlertDialogTitle>{`Open ${current.path} read-only?`}</AlertDialogTitle>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogClose variant="outline" testId="outside-file-cancel">Cancel</AlertDialogClose>
        {second && <AlertDialogClose variant="outline" testId={`outside-file-${second}`} onClick={choose(second)}>{LABEL[second]}</AlertDialogClose>}
        <AlertDialogClose variant="primary" testId={`outside-file-${first}`} onClick={choose(first!)}>{LABEL[first!]}</AlertDialogClose>
      </AlertDialogFooter>
    </AlertDialog>
  )
}
