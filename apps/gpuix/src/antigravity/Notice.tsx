// "Sign in anyway" / "Cancel" before the first Antigravity sign-in. The sign-in starts after the dialog has closed, so the
// dialog it opens next is not closed with it.
import { useRef } from 'react'
import { ANTIGRAVITY_SIGN_IN_NOTICE } from '../../../../packages/kybern-client/src/antigravity.ts'
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../kit/AlertDialog.tsx'
import { acknowledgeAntigravityNotice } from './notice.ts'

export function AntigravityNotice({ proceed, close }: { proceed: () => void; close: () => void }) {
  const confirmed = useRef(false)
  return (
    <AlertDialog open onOpenChange={(open) => { if (open) return; close(); if (confirmed.current) proceed() }} width={448} testId="antigravity-notice">
      <AlertDialogHeader>
        <AlertDialogTitle>Sign in to Antigravity?</AlertDialogTitle>
        <AlertDialogDescription>{ANTIGRAVITY_SIGN_IN_NOTICE}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogClose variant="outline" testId="antigravity-notice-cancel">Cancel</AlertDialogClose>
        <AlertDialogClose variant="default" testId="antigravity-notice-confirm" onClick={() => { confirmed.current = true; acknowledgeAntigravityNotice() }}>Sign in anyway</AlertDialogClose>
      </AlertDialogFooter>
    </AlertDialog>
  )
}
