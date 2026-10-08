// FILE: segmented-control.tsx
// Purpose: Radiogroup segmented control with one sliding thumb, styled like the sidebar's segmented picker.
// Layer: UI kit
// Exports: SegmentedControl

import { useRef } from "react"

import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/kit/tooltip"
import { cn } from "@/lib/utils"
import { useSlidingPill } from "@/lib/kit/slidingPill"

export interface SegmentedOption {
  value: string
  label: string
  /** Why this option cannot be chosen right now. It stays visible and focusable, explains itself in a tooltip, and ignores input. */
  unavailable?: string | null
}

/**
 * A few mutually exclusive values. Arrow keys move the choice and the focus
 * (roving tabindex). While `busy` the control stays focusable and keeps
 * focus, but ignores input: it is `aria-disabled`, never `disabled`, because a
 * disabled focused button drops focus to the body in WebKit. An option with an
 * `unavailable` reason is treated the same way and arrow keys skip it.
 */
export function SegmentedControl({
  options,
  value,
  onChange,
  busy = false,
  className,
  ...aria
}: {
  options: readonly SegmentedOption[]
  value: string
  onChange: (value: string) => void
  busy?: boolean
  className?: string
  "aria-labelledby"?: string
  "aria-label"?: string
}) {
  const [trackRef, pillStyle, pillReady] = useSlidingPill<HTMLDivElement>(`${value}:${options.map((option) => option.value).join(",")}`)
  const buttons = useRef(new Map<string, HTMLButtonElement>())

  const choose = (next: string) => {
    if (busy || next === value || options.find((option) => option.value === next)?.unavailable) return
    onChange(next)
  }

  return (
    <div
      ref={trackRef}
      role="radiogroup"
      aria-disabled={busy || undefined}
      {...aria}
      className={cn("sidebar-segmented-picker t-tabs inline-flex min-w-0 items-center gap-0.5 rounded-[0.5rem] p-0.5", className)}
      onKeyDown={(event) => {
        const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0
        if (!step) return
        event.preventDefault()
        if (busy) return
        const index = options.findIndex((option) => option.value === value)
        for (let offset = 1; offset <= options.length; offset++) {
          const next = options[(index + step * offset + options.length * offset) % options.length]!
          if (next.unavailable || next.value === value) continue
          choose(next.value)
          buttons.current.get(next.value)?.focus()
          break
        }
      }}
    >
      <span
        aria-hidden
        className="t-tabs-pill sidebar-segmented-thumb z-0 -ml-px -mt-px rounded-[0.375rem]"
        style={pillStyle}
        data-ready={pillReady}
      />
      {options.map((option) => {
        const selected = option.value === value
        const blocked = !!option.unavailable
        const button = (
          <button
            key={option.value}
            ref={(node) => {
              if (node) buttons.current.set(option.value, node)
              else buttons.current.delete(option.value)
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-disabled={busy || blocked || undefined}
            data-tab-active={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => choose(option.value)}
            className={cn(
              "press-row relative z-[1] h-6 min-w-9 rounded-[0.375rem] px-2 tabular-nums outline-none transition-colors duration-150 focus-visible:ring-1 focus-visible:ring-ring",
              (busy || blocked) && "cursor-default",
              selected ? "text-foreground" : blocked ? "text-muted-foreground/40" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        )
        if (!blocked) return button
        return (
          <Tooltip key={option.value}>
            <TooltipTrigger render={button} />
            <TooltipPopup side="top" sideOffset={6} variant="picker">{option.unavailable}</TooltipPopup>
          </Tooltip>
        )
      })}
    </div>
  )
}
