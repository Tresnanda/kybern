// The small marks Tasks is drawn with: Linear-style status glyphs (the only place
// status color lives), priority bars and monochrome agent marks. Project dots are
// the shared `ProjectDot` (lib/kit/projectDot.tsx).
import { useEffect, useRef } from "react"

import { ClaudeAI } from "@/components/kit/Icons"
import { ProviderIcon } from "@/components/kit/ProviderIcon"
import { observeLoopVisibility } from "@/lib/loopVisibility"
import { cn } from "@/lib/utils"
import type { ProviderKind, TaskPriority, TaskStatus } from "@/protocol"

const RUNNING_PIE = "M7 7V3.6A3.4 3.4 0 0 1 7 10.4Z"
const REVIEW_PIE = "M7 7V3.6A3.4 3.4 0 1 1 3.6 7Z"

/**
 * A task's status: dashed circle (inbox), circle (to do), half pie (running, its
 * fill breathing while visible), three-quarter pie (needs review), filled check
 * (done) and filled cross (canceled). `mono` draws it in the text color, for
 * navigation rows.
 */
export function TaskStatusGlyph({
  status,
  size = 14,
  mono = false,
  animated = false,
  className,
  title,
}: {
  status: TaskStatus
  size?: number
  mono?: boolean
  /** Let a running glyph breathe. It pauses offscreen and in hidden windows. */
  animated?: boolean
  className?: string
  /** Accessible name; omitted, the glyph is decorative. */
  title?: string
}) {
  const ref = useRef<SVGSVGElement>(null)
  const live = animated && status === "running" && !mono
  useEffect(() => {
    const element = ref.current
    if (!live || !element) return
    return observeLoopVisibility(element as unknown as HTMLElement)
  }, [live])
  const ring = (stroke: string, dashed = false) => (
    <circle cx="7" cy="7" r="5.75" fill="none" stroke={stroke} strokeWidth="1.5" strokeDasharray={dashed ? "1.45 1.56" : undefined} />
  )
  const color = (token: string) => (mono ? "currentColor" : `var(${token})`)
  let body
  switch (status) {
    case "inbox":
      body = ring(mono ? "currentColor" : "var(--task-fg3)", true)
      break
    case "todo":
      body = ring(mono ? "currentColor" : "var(--task-fg3)")
      break
    case "running":
      body = (
        <>
          {ring(color("--task-run"))}
          <path d={RUNNING_PIE} fill={color("--task-run")} className={live ? "task-glyph-breathe" : undefined} />
        </>
      )
      break
    case "needs_review":
      body = (
        <>
          {ring(color("--task-review"))}
          <path d={REVIEW_PIE} fill={color("--task-review")} />
        </>
      )
      break
    case "done":
      body = mono ? (
        <>
          {ring("currentColor")}
          <path d="M4.6 7.1 6.3 8.8 9.5 5.4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </>
      ) : (
        <>
          <circle cx="7" cy="7" r="6.5" fill="var(--task-done)" />
          <path d="M4.4 7.2 6.2 9 9.7 5.2" fill="none" stroke="var(--task-on-glyph)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )
      break
    case "canceled":
      body = (
        <>
          <circle cx="7" cy="7" r="6.5" fill={mono ? "currentColor" : "var(--task-fg4)"} />
          <path d="M5 5l4 4M9 5 5 9" stroke="var(--task-on-glyph)" strokeWidth="1.5" strokeLinecap="round" />
        </>
      )
      break
  }
  return (
    <svg
      ref={ref}
      width={size}
      height={size}
      viewBox="0 0 14 14"
      className={cn("task-glyph shrink-0", className)}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {body}
    </svg>
  )
}

/** Priority as Linear's bars; urgent is a filled orange square with "!". */
export function PriorityGlyph({ priority, size = 14, className }: { priority: TaskPriority; size?: number; className?: string }) {
  if (priority === 0) {
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" className={cn("shrink-0", className)} aria-hidden>
        <g fill="currentColor" opacity=".55">
          <rect x="1.5" y="6.25" width="2.6" height="1.5" rx=".75" />
          <rect x="5.7" y="6.25" width="2.6" height="1.5" rx=".75" />
          <rect x="9.9" y="6.25" width="2.6" height="1.5" rx=".75" />
        </g>
      </svg>
    )
  }
  if (priority === 1) {
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" className={cn("shrink-0", className)} aria-hidden>
        <rect x="1" y="1" width="12" height="12" rx="3" fill="var(--task-urgent)" />
        <path d="M7 3.9v3.6" stroke="var(--task-on-glyph)" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="7" cy="9.9" r=".95" fill="var(--task-on-glyph)" />
      </svg>
    )
  }
  const filled = { 2: 3, 3: 2, 4: 1 }[priority]
  const bars: [number, number, number][] = [
    [1.5, 8, 4],
    [5.75, 5, 7],
    [10, 2, 10],
  ]
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" className={cn("shrink-0", className)} aria-hidden>
      {bars.map(([x, y, h], index) => (
        <rect key={x} x={x} y={y} width="2.5" height={h} rx=".8" fill="currentColor" opacity={index < filled ? 1 : 0.3} />
      ))}
    </svg>
  )
}

const PROVIDER_ICON_KEY: Record<ProviderKind, string> = {
  "claude-code": "claudeAgent",
  codex: "codex",
  cursor: "cursor",
  opencode: "opencode",
  pi: "pi",
  omp: "omp",
}

/** The agent's mark, in the surrounding text color, so brand color never competes with status. */
export function AgentMark({ kind, size = 12, className }: { kind: ProviderKind; size?: number; className?: string }) {
  if (kind === "claude-code") return <ClaudeAI color="currentColor" width={size} height={size} className={cn("shrink-0", className)} aria-hidden />
  return <ProviderIcon provider={PROVIDER_ICON_KEY[kind]} className={cn("shrink-0 !text-current", className)} style={{ width: size, height: size }} />
}
