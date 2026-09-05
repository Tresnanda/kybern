// Small shared pieces: provider mark, logo, copy button, spinner.

import { useState } from "react"

import { ProviderIcon } from "@/components/kit/ProviderIcon"
import { copyText } from "@/lib/hooks"
import { CheckIcon, CopyIcon } from "@/lib/kit/icons"
import { cn } from "@/lib/utils"
import type { ProviderKind } from "@/protocol"

/** Provider glyph, using the kit icon set. */
const PROVIDER_ICON: Record<ProviderKind, string> = {
  "claude-code": "claudeAgent",
  codex: "codex",
  cursor: "cursor",
  opencode: "opencode",
  pi: "pi",
  omp: "omp",
}

export function ProviderMark({ kind, className, size = 14, tone }: { kind: ProviderKind; className?: string; size?: number; tone?: "default" | "header" }) {
  return <ProviderIcon provider={PROVIDER_ICON[kind]} tone={tone} className={cn("shrink-0", className)} style={{ width: size, height: size }} />
}

/** The Kybern mark. Monochrome and theme-aware through currentColor. */
export function Logo({ size = 40, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 504 315" className={cn("shrink-0", className)} aria-hidden>
      <path
        fill="currentColor"
        transform="matrix(0.99941953434 0 0 1.115949597003 0 0)"
        d="M423.91998 0.59084c105.84003 15.68001 112.56 281.67997-12.31997 281.67997-62.72004 0-101.92002-73.35997-136.64002-92.39998-10.08002-5.04-21.28-7.27999-33.04001-4.48001-34.15999 7.84003-63.27998 67.76001-118.15999 90.15996-8.96 3.36005-20.16 6.72003-33.03999 6.16004-54.88 1.11999-90.72-66.07998-90.72-141.11998 0-75.04001 36.4-142.23999 90.72-140.56 60.47998 0.56 91.84 53.76001 127.12 81.76001 13.43997 10.63998 23.51999 15.67998 37.51999 15.11999 40.88-1.68001 62.16-52.08002 112.55999-82.88 13.44001-7.84 33.04001-15.12 56-13.44z"
      />
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

/** Stepped spinner: 24 steps over 1.3s, drawn with currentColor. */
export function Spinner({ className, size = 14 }: { className?: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={cn("animate-spin-stepped shrink-0", className)} aria-hidden>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.2" strokeWidth="1.6" />
      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}
