// The detail's top bar: tabs on the left, every action on the right. Container
// queries on `pr-topbar` fold the icon actions into a More menu, then the labels
// into icons, then wrap the tabs onto a second row (see review.css).

import { useEffect, useRef, useState } from "react"

import { Button } from "@/components/kit/button"
import { ComposerPickerMenuPopup } from "@/components/kit/chat/ComposerPickerMenuPopup"
import { DiffStat } from "@/components/kit/diff-stat"
import { IconButton } from "@/components/kit/icon-button"
import { Menu, MenuGroup, MenuItem, MenuTrigger } from "@/components/kit/menu"
import { IconSwap } from "@/components/kybern/motion"
import { copyText } from "@/lib/hooks"
import {
  ArrowLeftIcon,
  CheckIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  LinkIcon,
  RefreshCwIcon,
} from "@/lib/kit/icons"
import { openExternal } from "@/lib/tauri"
import { cn } from "@/lib/utils"
import type { PrDetailResult } from "@/protocol"
import type { ReviewWorkspace } from "@/state/prReviewModel"

import { PR_FINE_TEXT, PR_QUIET_INK } from "./prText"
import { PrMergeButton } from "./PrMergeButton"
import { PrReviewPopover } from "./PrReviewPopover"
import { PrSendPopover } from "./PrSendPopover"
import { PrTabs, type PrTab } from "./PrTabs"
import type { PrActions } from "./usePrActions"

export function PrTopBar({
  actions,
  stateKey,
  number,
  dock,
  workspace,
  onWorkspace,
  panelId,
  detail,
  loading,
  onBack,
  onOpenFull,
  sendOpen,
  onSendOpen,
  reviewOpen,
  onReviewOpen,
}: {
  actions: PrActions
  stateKey: string
  number: number
  dock: boolean
  workspace: ReviewWorkspace
  onWorkspace: (workspace: ReviewWorkspace) => void
  panelId: string
  detail: PrDetailResult | null | undefined
  loading: boolean
  onBack?: () => void
  onOpenFull: () => void
  sendOpen: boolean
  onSendOpen: (open: boolean) => void
  reviewOpen: boolean
  onReviewOpen: (open: boolean) => void
}) {
  const pr = detail?.pull_request
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(copyTimer.current), [])
  const copyLink = () => {
    if (!pr) return
    void copyText(pr.url)
    setCopied(true)
    window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => setCopied(false), 1200)
  }
  const tabs: PrTab<ReviewWorkspace>[] = [
    { value: "overview", label: "Summary" },
    {
      value: "changes",
      label: "Changes",
      extra:
        pr?.additions != null && pr.deletions != null ? (
          <DiffStat
            className={cn("pr-tab-stat", PR_FINE_TEXT)}
            insertions={pr.additions}
            deletions={pr.deletions}
          />
        ) : undefined,
    },
    {
      value: "conversation",
      label: "Timeline",
      extra:
        detail?.comment_count != null ? (
          <span className={cn(PR_FINE_TEXT, PR_QUIET_INK, "tabular-nums")}>
            {detail.comment_count}
          </span>
        ) : undefined,
    },
  ]
  const refresh = () => void actions.refresh()
  return (
    <div className="pr-topbar shrink-0 border-b border-[color:var(--color-border)]">
      <div className="pr-topbar-row">
        {!dock && onBack && (
          <Button
            className="pr-back pr-topbar-back"
            size="icon-sm"
            variant="ghost"
            aria-label="Back to pull requests"
            onClick={onBack}
          >
            <ArrowLeftIcon className="size-4" />
          </Button>
        )}
        <PrTabs
          className="pr-topbar-tabs"
          value={workspace}
          tabs={tabs}
          onChange={onWorkspace}
          label="Review workspace"
          id={panelId}
        />
        <div className="pr-topbar-actions">
          {!dock && (
            <div className="pr-topbar-icons flex items-center gap-1">
              <IconButton
                variant="chrome"
                size="icon-sm"
                label="Refresh pull request"
                tooltip="Refresh"
                disabled={loading}
                onClick={refresh}
              >
                <RefreshCwIcon className={cn("size-4", loading && "animate-spin")} />
              </IconButton>
              <IconButton
                variant="chrome"
                size="icon-sm"
                label="Copy link"
                tooltip="Copy link"
                disabled={!pr}
                onClick={copyLink}
              >
                <IconSwap
                  active={copied ? "b" : "a"}
                  className="size-4"
                  a={<LinkIcon className="size-4" />}
                  b={<CheckIcon className="size-4" />}
                />
              </IconButton>
              <IconButton
                variant="chrome"
                size="icon-sm"
                label="Open on GitHub"
                tooltip="Open on GitHub"
                disabled={!pr}
                onClick={() => pr && void openExternal(pr.url)}
              >
                <ExternalLinkIcon className="size-4" />
              </IconButton>
            </div>
          )}
          <Menu>
            <IconButton
              render={<MenuTrigger />}
              className={cn("pr-topbar-more", !dock && "pr-topbar-more-folded")}
              variant="chrome"
              size="icon-sm"
              label="More actions"
              tooltip="More actions"
            >
              <EllipsisIcon className="size-4" />
            </IconButton>
            <ComposerPickerMenuPopup align="end">
              <MenuGroup>
                <MenuItem disabled={loading} onClick={refresh}>
                  Refresh
                </MenuItem>
                <MenuItem disabled={!pr} onClick={copyLink}>
                  Copy link
                </MenuItem>
                <MenuItem
                  disabled={!pr}
                  onClick={() => pr && void openExternal(pr.url)}
                >
                  Open on GitHub
                </MenuItem>
                {dock && <MenuItem onClick={onOpenFull}>Open full review</MenuItem>}
              </MenuGroup>
            </ComposerPickerMenuPopup>
          </Menu>
          {detail && (
            <>
              <PrSendPopover
                actions={actions}
                stateKey={stateKey}
                open={sendOpen}
                onOpenChange={onSendOpen}
                onOpenTimeline={() => onWorkspace("conversation")}
                onOpenChanges={() => onWorkspace("changes")}
              />
              <PrReviewPopover
                actions={actions}
                stateKey={stateKey}
                number={number}
                mode={dock ? "dock" : "page"}
                open={reviewOpen}
                onOpenChange={onReviewOpen}
              />
              <PrMergeButton actions={actions} />
            </>
          )}
        </div>
      </div>
    </div>
  )
}
