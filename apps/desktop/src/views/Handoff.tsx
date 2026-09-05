// "Hand off to another agent": pick a provider, start a new thread seeded with
// the conversation so far. Synara Dialog surface with picker-style rows.

import { useState } from "react"
import { toast } from "sonner"

import { ProviderMark, Spinner } from "@/components/kybern/bits"
import { Dialog, DialogDescription, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/synara/dialog"
import { ArrowRightIcon } from "@/lib/synara/icons"
import { cn } from "@/lib/utils"
import { errorText, handOff } from "@/state/rpc"
import { useStore } from "@/state/store"

export function HandoffDialog() {
  const threadId = useStore((s) => s.handoffThread)
  const thread = useStore((s) => (s.handoffThread ? s.threads[s.handoffThread] : undefined))
  const target = useStore((s) => s.handoffTarget)
  const providers = useStore((s) => s.providers)
  const set = useStore((s) => s.set)
  const [busy, setBusy] = useState<string | null>(null)

  const close = () => set({ handoffThread: null, handoffTarget: null })
  const choices = providers.filter((p) => p.available && p.kind !== thread?.provider.kind)

  return (
    <Dialog open={!!threadId} onOpenChange={(o) => !o && close()}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Hand off to another agent</DialogTitle>
          <DialogDescription>Starts a new thread in the same project. The new agent gets the conversation so far and continues from there.</DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-1 pb-5">
          {choices.length === 0 && <p className="text-[length:var(--app-font-size-ui,12px)] text-muted-foreground">No other agent is installed in this environment.</p>}
          {choices.map((p) => {
            const model = p.models?.find((m) => m.is_default) ?? p.models?.[0]
            return (
              <button
                key={p.kind}
                type="button"
                disabled={!!busy}
                autoFocus={target === p.kind}
                onClick={async () => {
                  if (!threadId) return
                  setBusy(p.kind)
                  try {
                    await handOff(threadId, { kind: p.kind, instance: "default" }, model?.id)
                    close()
                    toast("Handed off", { description: `${p.display_name} is picking up where this thread left off.` })
                  } catch (e) {
                    toast.error("Unable to hand off", { description: errorText(e) })
                  } finally {
                    setBusy(null)
                  }
                }}
                className={cn(
                  "group/opt flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[length:var(--app-font-size-ui,12px)] outline-none transition-colors hover:bg-[var(--color-background-button-secondary-hover)] focus-visible:bg-[var(--color-background-button-secondary-hover)] disabled:pointer-events-none disabled:opacity-50",
                  (busy === p.kind || target === p.kind) && "bg-[var(--color-background-button-secondary-hover)]",
                )}
              >
                <ProviderMark kind={p.kind} size={16} className="size-4 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-foreground">{p.display_name}</span>
                  {model && <span className="block truncate text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">{model.display_name}</span>}
                </span>
                {busy === p.kind ? <Spinner size={13} /> : <ArrowRightIcon className="size-3.5 text-muted-foreground opacity-0 transition-opacity group-hover/opt:opacity-100" />}
              </button>
            )
          })}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  )
}
