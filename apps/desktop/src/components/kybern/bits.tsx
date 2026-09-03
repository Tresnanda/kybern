// Small shared pieces: provider mark, logo, copy button, spinner.

import { useState } from "react"

import { ProviderIcon } from "@/components/synara/ProviderIcon"
import { copyText } from "@/lib/hooks"
import { CheckIcon, CopyIcon } from "@/lib/synara/icons"
import { cn } from "@/lib/utils"
import type { ProviderKind } from "@/protocol"

/** Provider glyph, using Synara's icon set. */
const SYNARA_PROVIDER: Record<ProviderKind, string> = {
  "claude-code": "claudeAgent",
  codex: "codex",
  cursor: "cursor",
  opencode: "opencode",
  pi: "pi",
  omp: "pi",
}

export function ProviderMark({ kind, className, size = 14, tone }: { kind: ProviderKind; className?: string; size?: number; tone?: "default" | "header" }) {
  return <ProviderIcon provider={SYNARA_PROVIDER[kind]} tone={tone} className={cn("shrink-0", className)} style={{ width: size, height: size }} />
}

/** The kybern mark: a helm ring with a rudder stroke. Monochrome, currentColor. */
export function Logo({ size = 40, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none" className={cn("shrink-0", className)} aria-hidden>
      <circle cx="20" cy="20" r="14" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="20" cy="20" r="4.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M20 6v4M20 30v4M6 20h4M30 20h4M10.1 10.1l2.8 2.8M27.1 27.1l2.8 2.8M29.9 10.1l-2.8 2.8M12.9 27.1l-2.8 2.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

export function CopyButton({ text, className, label = "Copy" }: { text: string; className?: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      aria-label={done ? "Copied" : label}
      className={cn(
        "inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-[var(--color-background-button-secondary-hover)] hover:text-foreground",
        className,
      )}
      onClick={() => {
        void copyText(text)
        setDone(true)
        setTimeout(() => setDone(false), 1400)
      }}
    >
      {done ? <CheckIcon className="size-3.5 text-success" /> : <CopyIcon className="size-3.5" />}
    </button>
  )
}

/** Synara's stepped spinner: 24 steps over 1.3s, drawn with currentColor. */
export function Spinner({ className, size = 14 }: { className?: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={cn("animate-spin-stepped shrink-0", className)} aria-hidden>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.2" strokeWidth="1.6" />
      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}
