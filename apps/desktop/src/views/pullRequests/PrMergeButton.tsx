import { Button } from "@/components/kit/button"
import { ComposerPickerMenuPopup } from "@/components/kit/chat/ComposerPickerMenuPopup"
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "@/components/kit/dialog"
import { Menu, MenuGroup, MenuItem, MenuTrigger } from "@/components/kit/menu"
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/kit/tooltip"
import { ChevronDownIcon } from "@/lib/kit/icons"
import type { PrActionKind } from "@/protocol"

import type { PrActions } from "./usePrActions"

const LABELS: Partial<Record<PrActionKind, string>> = {
  checkout: "Check out pull request",
  merge: "Merge pull request",
  close: "Close pull request",
}

/** The merge split button. Merged and closed pull requests get no control. */
export function PrMergeButton({ actions }: { actions: PrActions }) {
  const { pr, detail, busy, linked, linkedThread, openConfirmation } = actions
  if (!pr || pr.state !== "OPEN") return null
  const conflicts =
    pr.mergeable === "CONFLICTING" || detail?.merge_state_status === "DIRTY"
  const reason = pr.is_draft
    ? "Mark this pull request ready on GitHub before merging."
    : conflicts
      ? "Resolve conflicts before merging."
      : null
  const disabled = busy || !!reason
  return (
    <div className="flex items-center">
      <Tooltip>
        <TooltipTrigger
          render={
            // A disabled button gets no hover, so the tooltip sits on its wrapper.
            <span className="inline-flex" tabIndex={reason ? 0 : undefined} />
          }
        >
          <Button
            size="sm"
            className="rounded-e-none"
            disabled={disabled}
            onClick={() => openConfirmation("merge")}
          >
            Merge
          </Button>
        </TooltipTrigger>
        {reason && <TooltipPopup side="bottom">{reason}</TooltipPopup>}
      </Tooltip>
      <Menu>
        <MenuTrigger
          render={
            <Button
              size="icon-sm"
              aria-label="More merge options"
              className="w-6 rounded-s-none border-s border-s-primary-foreground/20"
            />
          }
        >
          <ChevronDownIcon className="size-3.5" />
        </MenuTrigger>
        <ComposerPickerMenuPopup align="end">
          <MenuGroup>
            <MenuItem
              disabled={
                busy ||
                !linked ||
                linkedThread?.status === "running" ||
                linkedThread?.status === "awaiting-approval"
              }
              onClick={() => openConfirmation("checkout")}
            >
              Check out in conversation
            </MenuItem>
            <MenuItem
              disabled={busy}
              onClick={() => openConfirmation("close")}
            >
              Close pull request
            </MenuItem>
          </MenuGroup>
        </ComposerPickerMenuPopup>
      </Menu>
    </div>
  )
}

export function PrConfirmDialog({
  actions,
  number,
}: {
  actions: PrActions
  number: number
}) {
  const { confirmation, setConfirmation, busy, pr, linkedThread, submit, actionError } =
    actions
  return (
    <Dialog
      open={confirmation !== null}
      onOpenChange={(open) => {
        if (!open && !busy) setConfirmation(null)
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{`${confirmation ? (LABELS[confirmation] ?? "Confirm") : "Confirm"}?`}</DialogTitle>
          <DialogDescription>
            {confirmation === "merge"
              ? `Squash merge #${number} at the reviewed head into ${pr?.base}. The branch stays available.`
              : confirmation === "close"
                ? `Close #${number} on GitHub. Its branch and your drafts remain available.`
                : `Check out #${number} in ${linkedThread?.title ?? "the linked conversation"}. Running work, dirty files and open terminals block checkout.`}
          </DialogDescription>
        </DialogHeader>
        {actionError && (
          <p role="alert" className="px-4 py-2 text-destructive">
            {actionError} Your draft is kept.
          </p>
        )}
        <DialogFooter>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => setConfirmation(null)}
          >
            Cancel
          </Button>
          <Button
            variant={confirmation === "close" ? "destructive-outline" : "default"}
            disabled={busy}
            onClick={() => confirmation && void submit(confirmation)}
          >
            {busy
              ? "Working…"
              : confirmation
                ? (LABELS[confirmation] ?? "Confirm")
                : "Confirm"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  )
}
