import { useState } from "react"

import { Button } from "@/components/kit/button"
import { copyText } from "@/lib/hooks"
import { CheckIcon, CopyIcon } from "@/lib/kit/icons"
import { truncateMiddle } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { PrDetailResult } from "@/protocol"

import { PrAvatar } from "./PrAvatar"
import { agoPhrase } from "./prFormat"
import { resolvePrState } from "./prState"
import {
  PR_FINE_TEXT,
  PR_META_TEXT,
  PR_QUIET_INK,
  PR_TITLE_TEXT,
} from "./prText"

export function PrHeader({
  detail,
  projectName,
  number,
  dock,
}: {
  detail: PrDetailResult
  projectName?: string
  number: number
  dock: boolean
}) {
  const pr = detail.pull_request
  const state = resolvePrState(pr, detail.merge_state_status)
  const [copied, setCopied] = useState(false)
  const opened = agoPhrase(pr.created_at ?? pr.updated_at)
  return (
    <header className="pr-summary-head flex min-w-0 flex-col">
      <div className="flex items-center gap-2">
        <span
          data-pr-state={state.kind}
          className={cn(
            "inline-flex h-6 items-center gap-1 rounded-full bg-[color-mix(in_srgb,currentColor_12%,transparent)] px-2 font-medium",
            PR_META_TEXT,
            state.colorClass
          )}
        >
          <state.Icon aria-hidden className="size-3.5" />
          {state.label}
        </span>
        <span className={cn(PR_META_TEXT, PR_QUIET_INK)}>
          {projectName ? `${projectName} ` : ""}#{number}
        </span>
      </div>
      <h2
        className={cn(
          "pr-title mt-2 break-words",
          PR_TITLE_TEXT,
          dock && "text-[length:calc(var(--app-font-size-ui-lg,13px)*1.25)]"
        )}
      >
        {pr.title}
      </h2>
      <div
        className={cn(
          "mt-2.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-muted-foreground",
          PR_META_TEXT
        )}
      >
        <PrAvatar
          login={pr.author}
          url={pr.author_avatar_url}
          bot={pr.author_is_bot}
          size={20}
        />
        <span className="font-medium text-foreground">{pr.author}</span>
        {opened && (
          <>
            <span aria-hidden>·</span>
            <time dateTime={pr.created_at ?? pr.updated_at}>opened {opened}</time>
          </>
        )}
        <span aria-hidden>·</span>
        <span
          className={cn("group/branch inline-flex min-w-0 items-center gap-1 font-mono", PR_FINE_TEXT)}
          title={`${pr.head} → ${pr.base}`}
        >
          <bdi>{truncateMiddle(pr.head, 32)}</bdi>
          <span aria-hidden>→</span>
          <bdi>{pr.base}</bdi>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Copy branch name"
            className="size-5 opacity-0 transition-opacity group-focus-within/branch:opacity-100 group-hover/branch:opacity-100"
            onClick={() => {
              void copyText(pr.head)
              setCopied(true)
              window.setTimeout(() => setCopied(false), 1200)
            }}
          >
            {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
          </Button>
        </span>
      </div>
      {!!pr.labels?.length && (
        <ul className="mt-2.5 flex flex-wrap gap-1.5" aria-label="Labels">
          {pr.labels.map((label) => {
            const color = `#${label.color || "888888"}`
            return (
              <li
                key={label.name}
                className={cn(
                  "inline-flex h-5 items-center gap-1 rounded-full border px-2 text-foreground/80",
                  PR_FINE_TEXT
                )}
                style={{ borderColor: `color-mix(in srgb, ${color} 40%, transparent)` }}
              >
                <span
                  aria-hidden
                  className="size-1.5 rounded-full"
                  style={{ backgroundColor: color }}
                />
                {label.name}
              </li>
            )
          })}
        </ul>
      )}
    </header>
  )
}
