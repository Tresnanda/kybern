// Send selected findings and inline drafts to an agent that repairs the branch.

import { Button } from "@/components/kit/button"
import { ComposerPickerMenuPopup } from "@/components/kit/chat/ComposerPickerMenuPopup"
import { Menu, MenuGroup, MenuItem, MenuTrigger } from "@/components/kit/menu"
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/kit/popover"
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/kit/tooltip"
import { plural } from "@/lib/format"
import { BotIcon, ChevronDownIcon } from "@/lib/kit/icons"
import { cn } from "@/lib/utils"
import { updateReviewDraft } from "@/state/prReview"

import { PR_FINE_TEXT, PR_META_TEXT, PR_QUIET_INK } from "./prText"
import type { PrActions } from "./usePrActions"

export function PrSendPopover({
  actions,
  stateKey,
  open,
  onOpenChange,
  onOpenTimeline,
  onOpenChanges,
}: {
  actions: PrActions
  stateKey: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpenTimeline: () => void
  onOpenChanges: () => void
}) {
  const { draft, selectedFindings, linkedThread, choices, busy, staleDraft, settings, repair } =
    actions
  const comments = selectedFindings.length
  const inline = draft.inline.length
  const n = comments + inline
  const previews = [
    ...selectedFindings.map((f) => ({
      path: f.path ? `${f.path}:${f.line ?? "outdated"}` : `Review by ${f.author}`,
      body: f.body,
    })),
    ...draft.inline.map((c) => ({ path: `${c.path}:${c.line}`, body: c.body })),
  ]
  const blocked =
    linkedThread?.status === "running" || linkedThread?.status === "awaiting-approval"
  const contents = [
    comments ? plural(comments, "comment") : "",
    inline ? plural(inline, "inline draft") : "",
  ]
    .filter(Boolean)
    .join(" and ")
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={n ? `Send to agent, ${n} selected` : "Send to agent"}
                />
              }
            />
          }
        >
          <BotIcon className="size-3.5" />
          <span className="pr-topbar-label">Send to agent</span>
          {n > 0 && (
            <span className="rounded-full bg-[var(--color-background-button-secondary)] px-1.5 tabular-nums">
              {n}
            </span>
          )}
        </TooltipTrigger>
        <TooltipPopup side="bottom">Send findings to an agent</TooltipPopup>
      </Tooltip>
      <PopoverPopup
        align="end"
        sideOffset={6}
        className="w-[24rem] max-w-[calc(100vw-2rem)]"
      >
        <div className="flex flex-col gap-3" data-pr-send-popover>
          <div>
            <h2 className={cn(PR_META_TEXT, "font-medium")}>Send to agent</h2>
            <p className={cn(PR_FINE_TEXT, PR_QUIET_INK)}>
              The agent repairs this branch. You review and merge separately.
            </p>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className={cn(PR_FINE_TEXT, "text-muted-foreground")}>
              Conversation
            </span>
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    variant="outline"
                    size="sm"
                    className="min-w-0 max-w-[16rem] justify-between"
                  />
                }
              >
                <span className="truncate">
                  {linkedThread?.title ?? "New repair conversation"}
                </span>
                <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
              </MenuTrigger>
              <ComposerPickerMenuPopup align="end" className="max-w-80">
                <MenuGroup>
                  <MenuItem
                    onClick={() => updateReviewDraft(stateKey, { threadId: "new" })}
                  >
                    New repair conversation
                  </MenuItem>
                  {choices.map((t) => (
                    <MenuItem
                      key={t.id}
                      onClick={() => updateReviewDraft(stateKey, { threadId: t.id })}
                    >
                      <span className="truncate">{t.title}</span>
                    </MenuItem>
                  ))}
                </MenuGroup>
              </ComposerPickerMenuPopup>
            </Menu>
          </div>
          {n === 0 ? (
            <div className="flex flex-col gap-2">
              <p className="leading-relaxed text-muted-foreground">
                Select comments in Timeline or add inline comments in Changes,
                then send them here.
              </p>
              <div className="flex gap-1">
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => {
                    onOpenChange(false)
                    onOpenTimeline()
                  }}
                >
                  Open timeline
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => {
                    onOpenChange(false)
                    onOpenChanges()
                  }}
                >
                  Open changes
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <p className={cn(PR_META_TEXT, "text-muted-foreground")}>{contents}</p>
              <ul className="flex flex-col gap-2">
                {previews.slice(0, 3).map((p, i) => (
                  <li key={i} className="min-w-0">
                    <span className={cn("block truncate font-mono", PR_FINE_TEXT, PR_QUIET_INK)}>
                      {p.path}
                    </span>
                    <span className="line-clamp-2 break-words">{p.body}</span>
                  </li>
                ))}
                {previews.length > 3 && (
                  <li className={cn(PR_FINE_TEXT, PR_QUIET_INK)}>
                    +{previews.length - 3} more
                  </li>
                )}
              </ul>
            </div>
          )}
          {actions.actionError && !actions.confirmation && (
            <p role="alert" className="break-words text-destructive">
              {actions.actionError} Your draft is kept. Check the pull request and
              try again.
            </p>
          )}
          <div className="flex justify-end">
            <Button
              size="sm"
              disabled={busy || !settings || staleDraft || n === 0 || blocked}
              onClick={async () => {
                if (await repair()) onOpenChange(false)
              }}
            >
              {busy ? "Sending…" : `Send ${n} ${n === 1 ? "finding" : "findings"}`}
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  )
}
