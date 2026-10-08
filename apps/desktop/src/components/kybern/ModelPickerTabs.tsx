// FILE: ModelPickerTabs.tsx
// Purpose: The model picker's header: a Starred tab, then one tab per agent
// account. An agent with a single account keeps one icon-only tab; an agent with
// several gets a tab per account, and the selected one names itself. A quiet
// line under the strip says whether the thread follows defaults or is pinned.
// Layer: Composer UI
// Exports: ModelPickerTabs, FollowDefaultsLine

import { useRef } from "react"

import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/kit/tooltip"
import { AccountDot, AccountMarkStack } from "@/components/kybern/accounts/AccountMark"
import { Spinner } from "@/components/kybern/bits"
import { nextTabIndex, type FollowLine, type PickerTab } from "@/lib/accountUi"
import { RefreshCwIcon, StarFilledIcon, StarIcon } from "@/lib/kit/icons"
import { cn } from "@/lib/utils"

const TAB_CLASS_NAME =
  "press-row relative inline-flex h-7 min-w-7 shrink-0 items-center justify-center gap-1.5 rounded-[0.4rem] px-1.5 outline-none transition-[background-color,opacity] duration-150 focus-visible:ring-1 focus-visible:ring-ring"
const ICON_BUTTON_CLASS_NAME =
  "press-row inline-flex size-7 shrink-0 items-center justify-center rounded-[0.4rem] text-muted-foreground/60 outline-none transition-colors duration-150 hover:bg-[var(--color-background-button-secondary-hover)] hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:hover:bg-transparent"

export function ModelPickerTabs({
  tabs,
  busy,
  canReload,
  loading,
  onStarred,
  onAccount,
  onReload,
}: {
  tabs: PickerTab[]
  busy: boolean
  canReload: boolean
  loading: boolean
  onStarred: () => void
  onAccount: (tab: Extract<PickerTab, { type: "account" }>) => void
  onReload: () => void
}) {
  const list = useRef<HTMLDivElement>(null)
  const selectedIndex = Math.max(0, tabs.findIndex((tab) => tab.selected))
  const move = (event: React.KeyboardEvent, index: number) => {
    let target = -1
    if (event.key === "ArrowRight") target = nextTabIndex(tabs, index, 1)
    else if (event.key === "ArrowLeft") target = nextTabIndex(tabs, index, -1)
    else if (event.key === "Home") target = nextTabIndex(tabs, -1, 1)
    else if (event.key === "End") target = nextTabIndex(tabs, tabs.length, -1)
    if (target < 0) return
    event.preventDefault()
    list.current?.querySelectorAll<HTMLElement>('[role="tab"]')[target]?.focus()
  }
  return (
    <div className="flex items-center gap-0.5 px-1.5 pt-1.5">
      <div ref={list} role="tablist" aria-label="Agents and accounts" className="scroll-fade-x flex min-w-0 items-center gap-0.5 overflow-x-auto pb-1 [scrollbar-width:none]">
        {tabs.map((tab, index) => {
          const tabIndex = index === selectedIndex ? 0 : -1
          if (tab.type === "starred") {
            return (
              <Tooltip key={tab.key}>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      role="tab"
                      aria-selected={tab.selected}
                      aria-label={tab.label}
                      tabIndex={tabIndex}
                      onClick={onStarred}
                      onKeyDown={(event) => move(event, index)}
                      className={cn(TAB_CLASS_NAME, tab.selected ? "bg-[var(--color-background-button-secondary)] text-[var(--color-accent-yellow)]" : "text-muted-foreground opacity-45 hover:bg-[var(--color-background-button-secondary-hover)] hover:opacity-100")}
                    />
                  }
                >
                  {tab.selected ? <StarFilledIcon className="size-3.5" /> : <StarIcon className="size-3.5" />}
                </TooltipTrigger>
                <TooltipPopup side="top" sideOffset={6} variant="picker">{tab.tooltip}</TooltipPopup>
              </Tooltip>
            )
          }
          return (
            <Tooltip key={tab.key}>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    role="tab"
                    aria-selected={tab.selected}
                    aria-label={tab.ariaLabel}
                    aria-disabled={tab.disabled || tab.notSetUp || undefined}
                    tabIndex={tabIndex}
                    disabled={busy && !tab.selected}
                    onClick={() => { if (!tab.disabled) onAccount(tab) }}
                    onKeyDown={(event) => move(event, index)}
                    className={cn(
                      TAB_CLASS_NAME,
                      tab.selected
                        ? "bg-[var(--color-background-button-secondary)]"
                        : tab.needsSignIn
                          ? "opacity-30 hover:bg-[var(--color-background-button-secondary-hover)] hover:opacity-60"
                          : tab.notSetUp
                            ? "opacity-20 hover:bg-[var(--color-background-button-secondary-hover)] hover:opacity-60"
                            : tab.disabled
                              ? "cursor-default opacity-20"
                              : "opacity-45 hover:bg-[var(--color-background-button-secondary-hover)] hover:opacity-100 disabled:opacity-20 disabled:hover:bg-transparent",
                    )}
                  />
                }
              >
                <AccountMarkStack kind={tab.kind} color={tab.color} size={14} />
                {tab.label && <span className="max-w-24 truncate text-[length:var(--app-font-size-ui-sm,11px)] leading-none"><bdi>{tab.label}</bdi></span>}
                {tab.selected && tab.multi && (
                  <span aria-hidden className="pointer-events-none absolute inset-x-1.5 -bottom-1 h-0.5 rounded-full" style={{ backgroundColor: tab.color ? `var(--account-${tab.color})` : "color-mix(in srgb, currentColor 40%, transparent)" }} />
                )}
              </TooltipTrigger>
              <TooltipPopup side="top" sideOffset={6} variant="picker">{tab.tooltip}</TooltipPopup>
            </Tooltip>
          )
        })}
      </div>
      {canReload && (
        <div className="ms-auto flex shrink-0 items-center">
          <Tooltip>
            <TooltipTrigger render={<button type="button" aria-label="Reload models" disabled={loading} onClick={onReload} className={ICON_BUTTON_CLASS_NAME} />}>
              {loading ? <Spinner size={12} /> : <RefreshCwIcon className="size-3.5" />}
            </TooltipTrigger>
            <TooltipPopup side="top" sideOffset={6} variant="picker">{loading ? "Reloading models…" : "Reload models"}</TooltipPopup>
          </Tooltip>
        </div>
      )}
    </div>
  )
}

/** "Following defaults · Work", or "This thread uses Work" with a way back to defaults. */
export function FollowDefaultsLine({ line, busy, onFollow }: { line: FollowLine; busy: boolean; onFollow: () => void }) {
  return (
    <div className="flex h-7 items-center gap-1.5 px-3 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
      {/* The dot leads the name, so a truncated name never leaves it next to "Follow defaults". */}
      <span className="flex min-w-0 items-center gap-1">
        <span className="shrink-0">{line.state === "following" ? "Following defaults ·" : "This thread uses"}</span>
        <AccountDot color={line.color} className="ms-0.5 ring-0" />
        <bdi className="min-w-0 truncate">{line.name}</bdi>
      </span>
      {line.state === "pinned" && (
        <button type="button" disabled={busy} onClick={onFollow} className="press-row ms-auto shrink-0 rounded-sm font-medium text-foreground/80 outline-none transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50">
          {line.action}
        </button>
      )}
    </div>
  )
}
