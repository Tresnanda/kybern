// Asks before the window closes while threads are still working. Agents run
// in the daemon and keep going after the window is gone, so this is a
// heads-up with a way to stop them, not a warning about losing work.

import { useEffect, useState } from "react"
import { toast } from "sonner"

import { ProviderMark } from "@/components/kybern/bits"
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/kit/alert-dialog"
import { Button } from "@/components/kit/button"
import { Checkbox } from "@/components/kit/checkbox"
import { Label } from "@/components/kit/label"
import { isTauri } from "@/lib/tauri"
import type { Thread } from "@/protocol"
import { askBeforeClose, setAskBeforeClose } from "@/state/closeGuard"
import { errorText, interrupt } from "@/state/rpc"
import { useStore } from "@/state/store"

const SHOWN_THREADS = 4

/** Set once the user has answered, so the close we issue is not intercepted again. */
let allowClose = false

async function closeWindow(): Promise<void> {
  allowClose = true
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window")
    await getCurrentWindow().close()
  } catch (error) {
    allowClose = false
    toast.error("Unable to close the window", { description: errorText(error) })
  }
}

function busyThreads(): Thread[] {
  return Object.values(useStore.getState().threads).filter((t) => t.status === "running" || t.status === "awaiting-approval")
}

function title(threads: Thread[]): string {
  const waiting = threads.filter((t) => t.status === "awaiting-approval").length
  const count = threads.length
  if (waiting === count) return count === 1 ? "1 thread is waiting for your approval" : `${count} threads are waiting for your approval`
  return count === 1 ? "1 thread is still working" : `${count} threads are still working`
}

export function CloseGuard() {
  const [pending, setPending] = useState<Thread[] | null>(null)
  const [stopping, setStopping] = useState(false)
  const [askAgain, setAskAgain] = useState(true)

  useEffect(() => {
    if (!isTauri()) return
    let disposed = false
    let unlisten: (() => void) | undefined
    void (async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window")
      const off = await getCurrentWindow().onCloseRequested((event) => {
        if (allowClose || !askBeforeClose()) return
        const busy = busyThreads()
        if (busy.length === 0) return
        event.preventDefault()
        setAskAgain(true)
        setPending(busy)
      })
      if (disposed) off()
      else unlisten = off
    })()
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  const dismiss = () => {
    if (stopping) return
    setPending(null)
  }

  const remember = () => {
    if (!askAgain) setAskBeforeClose(false)
  }

  const closeAndKeepWorking = async () => {
    remember()
    await closeWindow()
  }

  const stopAndClose = async () => {
    if (!pending) return
    setStopping(true)
    try {
      await Promise.all(pending.map((t) => interrupt(t.id)))
      remember()
      await closeWindow()
    } catch (error) {
      setStopping(false)
      toast.error("Unable to stop every thread", { description: errorText(error) })
    }
  }

  const threads = pending ?? []
  const waiting = threads.some((t) => t.status === "awaiting-approval")
  const shown = threads.slice(0, SHOWN_THREADS)
  const more = threads.length - shown.length

  return (
    <AlertDialog open={pending !== null} onOpenChange={(open) => !open && dismiss()}>
      <AlertDialogPopup className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-balance">{title(threads)}</AlertDialogTitle>
          <AlertDialogDescription className="text-pretty">
            Agents keep working after the window closes. Open Kybern again to see what they did.
            {waiting && " Threads waiting for approval stay paused until you answer."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="flex flex-col gap-0.5 px-4 pt-1 pb-3" aria-label="Threads still working">
          {shown.map((t) => (
            <li key={t.id} className="flex min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[length:var(--app-font-size-ui,12px)]">
              <ProviderMark kind={t.provider.kind} size={16} className="size-4" />
              <span className="min-w-0 flex-1 truncate text-foreground">{t.title}</span>
              <span className="shrink-0 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
                {t.status === "awaiting-approval" ? "Waiting for approval" : "Working"}
              </span>
            </li>
          ))}
          {more > 0 && <li className="px-2.5 py-1 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">and {more} more</li>}
        </ul>
        <div className="px-4 pb-1">
          <Label className="cursor-pointer font-normal text-muted-foreground">
            <Checkbox checked={askAgain} onCheckedChange={(checked) => setAskAgain(checked === true)} />
            Ask again next time
          </Label>
        </div>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="chrome-outline" />} disabled={stopping}>
            Cancel
          </AlertDialogClose>
          <Button variant="destructive-outline" disabled={stopping} onClick={() => void stopAndClose()}>
            {stopping ? "Stopping…" : "Stop threads and close"}
          </Button>
          <Button autoFocus disabled={stopping} onClick={() => void closeAndKeepWorking()}>
            Close window
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  )
}
