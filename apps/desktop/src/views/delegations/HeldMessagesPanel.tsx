// Messages another thread wants to send here but could not deliver by itself (its permissions are
// broader than this thread's). They wait in the composer stack as a pending card until the reader
// delivers or dismisses them. Nothing is delivered silently.

import { memo, useState } from "react"

import { heldHeadline, messageSenderName, plainLine, purposeLabel } from "../../../../../packages/kybern-client/src/delegations.ts"
import { DisclosureChevron } from "@/components/kit/DisclosureChevron"
import { DisclosureRegion } from "@/components/kit/DisclosureRegion"
import { Button } from "@/components/kit/button"
import { ComposerStackedPanel, COMPOSER_STACKED_PANEL_DIVIDER_CLASS_NAME } from "@/components/kit/chat/ComposerStackedPanel"
import { ComposerStackedPanelRow, ComposerStackedPanelRowMain } from "@/components/kit/chat/ComposerStackedPanelContent"
import { COMPOSER_STACKED_PANEL_ICON_CLASS_NAME } from "@/components/kit/chat/composerStackedPanelStyles"
import { HandRaisedIcon } from "@/lib/kit/icons"
import { cn } from "@/lib/utils"
import type { ThreadId, ThreadMessageRecord } from "@/protocol"
import { deliverHeldMessage, dismissHeldMessage, useHeldMessages } from "@/state/delegations"
import { useStore } from "@/state/store"

/** Nothing renders without held messages, so a quiet thread pays nothing for this panel. */
export function HeldMessagesPanel({ threadId }: { threadId: ThreadId }) {
  const held = useHeldMessages(threadId)
  if (held.length === 0) return null
  return (
    <ComposerStackedPanel className="t-panel-enter flex max-h-64 flex-col overflow-y-auto" data-held-messages="">
      {held.map((message, index) => (
        <HeldRow key={message.id} message={message} divided={index > 0} />
      ))}
    </ComposerStackedPanel>
  )
}

const HeldRow = memo(function HeldRow({ message, divided }: { message: ThreadMessageRecord; divided: boolean }) {
  const [entered, setEntered] = useState(false)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<"deliver" | "dismiss" | null>(null)
  const connected = useStore((state) => state.connection.state === "open")
  const sender = useStore((state) => (message.from_thread_id ? state.threads[message.from_thread_id]?.title : undefined))
  const name = messageSenderName({ from_thread_id: message.from_thread_id, from_title: sender ?? "" })
  const headline = heldHeadline(name, message.purpose)
  const preview = plainLine(message.body, 200)
  const kindWord = purposeLabel(message.purpose).toLowerCase()
  const act = async (kind: "deliver" | "dismiss") => {
    setBusy(kind)
    const done = kind === "deliver" ? await deliverHeldMessage(message) : await dismissHeldMessage(message)
    // On success the row leaves with the store update; on failure it stays, usable again.
    if (!done) setBusy(null)
  }
  return (
    <ComposerStackedPanelRow
      data-testid="held-message-row"
      onAnimationEnd={(event) => { if (event.target === event.currentTarget) setEntered(true) }}
      className={cn("items-start", !entered && "t-row-enter", divided && COMPOSER_STACKED_PANEL_DIVIDER_CLASS_NAME)}
    >
      <ComposerStackedPanelRowMain className="items-start">
        <HandRaisedIcon className={cn(COMPOSER_STACKED_PANEL_ICON_CLASS_NAME, "mt-[3px] text-amber-600 dark:text-amber-300/90")} aria-hidden />
        <div className="min-w-0 flex-1">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            className="flex w-full min-w-0 cursor-pointer flex-col text-start outline-hidden focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="min-w-0 truncate font-medium text-foreground/85">{headline}</span>
              <DisclosureChevron open={open} className="shrink-0" />
            </span>
            {!open && preview && <span className="line-clamp-2 text-[12px] leading-[1.4] text-muted-foreground/80" title={preview}>{preview}</span>}
          </button>
          <DisclosureRegion open={open}>
            <div className="flex flex-col gap-1.5 pt-1.5 pb-1">
              <p className="selectable max-h-40 overflow-y-auto text-[12.5px] leading-relaxed break-words whitespace-pre-wrap text-foreground/85">{message.body}</p>
              <p className="text-[11px] text-muted-foreground/70">
                {purposeLabel(message.purpose)}
                {message.held_reason ? ` · ${message.held_reason}` : ""}
              </p>
            </div>
          </DisclosureRegion>
        </div>
      </ComposerStackedPanelRowMain>
      <div className="flex shrink-0 items-center gap-0.5">
        <Button variant="ghost" size="chip" aria-label={`Dismiss ${kindWord} from ${name}`} disabled={!connected || busy !== null} onClick={() => void act("dismiss")}>
          {busy === "dismiss" ? "Dismissing…" : "Dismiss"}
        </Button>
        <Button variant="subtle" size="chip" aria-label={`Deliver ${kindWord} from ${name}`} disabled={!connected || busy !== null} onClick={() => void act("deliver")}>
          {busy === "deliver" ? "Delivering…" : "Deliver"}
        </Button>
      </div>
    </ComposerStackedPanelRow>
  )
})
