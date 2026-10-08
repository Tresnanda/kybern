import { useRef, type ReactNode } from "react"

import { useSlidingPill } from "@/lib/kit/slidingPill"
import { cn } from "@/lib/utils"

import { PR_META_TEXT } from "./prText"

export interface PrTab<T extends string> {
  value: T
  label: string
  /** Quiet trailing content such as a count or diff stat. */
  extra?: ReactNode
}

/** Sliding-pill tablist with roving arrow keys; internal ids stay stable while labels change. */
export function PrTabs<T extends string>({
  value,
  tabs,
  onChange,
  label,
  id,
  size = "md",
  className,
}: {
  value: T
  tabs: readonly PrTab<T>[]
  onChange: (value: T) => void
  label: string
  id: string
  size?: "sm" | "md"
  className?: string
}) {
  const [trackRef, pillStyle, pillReady] = useSlidingPill<HTMLDivElement>(
    `${value}:${tabs.map((t) => t.value).join(",")}`
  )
  const buttons = useRef(new Map<string, HTMLButtonElement>())
  return (
    <div
      ref={trackRef}
      role="tablist"
      aria-label={label}
      className={cn("t-tabs relative flex min-w-0 items-center gap-0.5 overflow-hidden", className)}
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
        const index = tabs.findIndex((t) => t.value === value)
        event.preventDefault()
        const rtl = getComputedStyle(event.currentTarget).direction === "rtl"
        const step = event.key === "ArrowRight" ? (rtl ? -1 : 1) : rtl ? 1 : -1
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? tabs.length - 1
              : (index + step + tabs.length) % tabs.length
        const target = tabs[next]!.value
        onChange(target)
        buttons.current.get(target)?.focus()
      }}
    >
      <span
        aria-hidden
        className="t-tabs-pill z-0 rounded-md bg-[var(--color-background-button-secondary)]"
        style={pillStyle}
        data-ready={pillReady}
      />
      {tabs.map((tab) => {
        const selected = tab.value === value
        return (
          <button
            key={tab.value}
            ref={(node) => {
              if (node) buttons.current.set(tab.value, node)
              else buttons.current.delete(tab.value)
            }}
            id={`${id}-${tab.value}`}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={`${id}-panel`}
            data-tab-active={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.value)}
            className={cn(
              "pr-tab press-row relative z-[1] inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 whitespace-nowrap outline-none transition-colors duration-150 focus-visible:ring-1 focus-visible:ring-ring",
              size === "md" ? "h-7" : "h-6",
              PR_META_TEXT,
              selected
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {tab.label}
            {tab.extra}
          </button>
        )
      })}
    </div>
  )
}
