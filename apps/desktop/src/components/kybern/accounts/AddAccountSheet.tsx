// Placeholder until the sheet lands; keeps `openAddAccount` callable.
import { Dialog, DialogCreateHandle, DialogPopup, DialogHeader, DialogTitle } from "@/components/kit/dialog"
import type { ProviderKind } from "@/protocol"

export interface AddAccountRequest {
  /** Start with this agent selected. */
  kind?: ProviderKind
  /** Sign in again to this existing account instead of adding one. */
  instance?: string
}

const handle = DialogCreateHandle<AddAccountRequest>()

// eslint-disable-next-line react-refresh/only-export-components
export function openAddAccount(request: AddAccountRequest = {}) {
  handle.openWithPayload(request)
}

export function AddAccountSheet() {
  return (
    <Dialog handle={handle}>
      <DialogPopup className="max-w-md">
        <DialogHeader><DialogTitle>Add an account</DialogTitle></DialogHeader>
      </DialogPopup>
    </Dialog>
  )
}
