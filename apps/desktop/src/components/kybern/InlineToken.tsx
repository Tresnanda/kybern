// Inline token for a `$skill`, `@plugin`, `@thread`, `@file` or `@image1` inside message text.
// Tokens read as colored text led by an icon, with no box behind them. The raw
// sigil and a thread's quotes are dropped for display. Sent bubbles render this
// component; the composer builds the same markup with `InlineTokenIcon` and
// `inlineTokenLabel` so the two always match.

import { FileEntryIcon } from "@/components/kit/chat/FileEntryIcon"
import { DeviceLaptopIcon, MessageCircleIcon, PluginIcon, SkillCubeIcon } from "@/lib/kit/icons"
import { inlineTokenLabel, type InlineTokenKind } from "@/lib/inlineTokenLabel"
import { cn } from "@/lib/utils"

export type { InlineTokenKind }

export interface InlineTokenDescriptor {
  kind: InlineTokenKind
  onClick?: () => void
  label?: string
}

export function InlineTokenIcon({ kind, text }: { kind: InlineTokenKind; text: string }) {
  switch (kind) {
    case "skill":
      return <SkillCubeIcon aria-hidden />
    case "plugin":
      return <PluginIcon aria-hidden />
    case "computer":
      return <DeviceLaptopIcon aria-hidden />
    case "thread":
      return <MessageCircleIcon aria-hidden />
    case "attachment":
      return <FileEntryIcon pathValue={text.slice(1)} kind="file" mimeType={text.startsWith("@image") ? "image/png" : null} />
    default:
      return <FileEntryIcon pathValue={text.slice(1)} kind="file" />
  }
}

export function InlineToken({ kind, text, className, onClick, label }: { kind: InlineTokenKind; text: string; className?: string; onClick?: () => void; label?: string }) {
  const content = (
    <>
      <InlineTokenIcon kind={kind} text={text} />
      {inlineTokenLabel(kind, text)}
    </>
  )
  if (onClick) return <button type="button" className={cn("chat-inline-token cursor-pointer outline-hidden focus-visible:ring-1 focus-visible:ring-ring", className)} data-kind={kind} onClick={onClick} aria-label={label} title={label}>{content}</button>
  return <span className={cn("chat-inline-token", className)} data-kind={kind}>{content}</span>
}
