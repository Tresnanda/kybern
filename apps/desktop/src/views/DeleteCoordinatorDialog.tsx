import { useState } from "react"
import { Button } from "@/components/kit/button"
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/kit/dialog"
import type { Thread } from "@/protocol"
import { activeRuntime, errorText } from "@/state/rpc"
import { useStore } from "@/state/store"

/** Mounted per confirmation so retries retain the exact reviewed identity. */
export function DeleteCoordinatorDialog({ thread, onClose }: { thread: Thread; onClose: () => void }) {
  const [origin] = useState(() => ({ runtime: activeRuntime(), store: useStore, request: {
    operation_id: crypto.randomUUID(), project_id: thread.project_id, thread_id: thread.id,
  } }))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  async function remove() {
    if (busy) return
    setBusy(true)
    setError("")
    try {
      if (origin.runtime !== activeRuntime()) throw new Error("The connected environment changed. Reopen this coordinator before deleting it.")
      const archived = await origin.runtime.rpc().call("collaboration.coordinator.delete", origin.request)
      origin.store.getState().set((state) => ({ threads: { ...state.threads, [archived.id]: archived } }))
      origin.store.getState().removeThreadFromSplit(archived.id)
      if (origin.runtime === activeRuntime()) {
        const selected = origin.store.getState().selected
        if (selected.kind === "thread" && selected.id === archived.id) origin.store.getState().selectDraft(archived.project_id)
        onClose()
      }
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose() }}>
    <DialogPopup>
      <DialogHeader>
        <DialogTitle>Delete coordinator?</DialogTitle>
        <DialogDescription>You can create a fresh coordinator afterward. This conversation is archived; worker conversations, results, files, and previous knowledge remain in history. The new coordinator starts with fresh knowledge.</DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <p className="text-xs leading-relaxed text-muted-foreground">Stop active agents and remove queued messages before deleting.</p>
        {error && <p role="alert" className="mt-3 text-xs leading-relaxed text-destructive">{error}</p>}
      </DialogPanel>
      <DialogFooter>
        <Button variant="secondary-outline" disabled={busy} onClick={onClose}>Cancel</Button>
        <Button variant="destructive" disabled={busy} onClick={() => void remove()}>{busy ? "Deleting…" : "Delete coordinator"}</Button>
      </DialogFooter>
    </DialogPopup>
  </Dialog>
}
