// Inline token for a `$skill`, `@plugin`, `@thread`, `@note`, `@task`, `@file` or `@image1` inside message text.
// Tokens read as colored text led by an icon, with no box behind them. The raw
// sigil and a thread's quotes are dropped for display. Sent bubbles render this
// component; the composer builds the same markup with `InlineTokenIcon` and
// `inlineTokenLabel` so the two always match.

import { FileEntryIcon } from "@/components/kit/chat/FileEntryIcon"
import { DeviceLaptopIcon, ListChecksIcon, MessageCircleIcon, NoteIcon, PluginIcon, SkillCubeIcon } from "@/lib/kit/icons"
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
    case "note":
      return <NoteIcon aria-hidden />
    case "task":
      return <ListChecksIcon aria-hidden />
    case "attachment":
      return <FileEntryIcon pathValue={text.slice(1)} kind="file" mimeType={text.startsWith("@image") ? "image/png" : null} />
    default:
      return <FileEntryIcon pathValue={text.slice(1)} kind="file" />
  }
}

export function InlineToken({ kind, text, className, onClick, label, display, gone }: {
  kind: InlineTokenKind
  text: string
  className?: string
  onClick?: () => void
  label?: string
  /** Shown instead of the label derived from `text`, e.g. a live title that may begin with a quote. */
  display?: string
  /** The item it names no longer exists: quiet, and never a link. */
  gone?: boolean
}) {
  // The icon travels with the first word (`chat-inline-token-lead`) so inside a
  // message the rest of a long title can wrap like running text.
  const [, first = "", rest = ""] = /^(\S*)([\s\S]*)$/.exec(display ?? inlineTokenLabel(kind, text)) ?? []
  const content = (
    <>
      <span className="chat-inline-token-lead">
        <InlineTokenIcon kind={kind} text={text} />
        {first}
      </span>
      {rest}
    </>
  )
  // An inline link, not a button: a button cannot break across lines.
  if (onClick) {
    return (
      <span
        role="link"
        tabIndex={0}
        className={cn("chat-inline-token cursor-pointer outline-hidden focus-visible:ring-1 focus-visible:ring-ring", className)}
        data-kind={kind}
        onClick={onClick}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return
          event.preventDefault()
          onClick()
        }}
        aria-label={label}
        title={label}
      >
        {content}
      </span>
    )
  }
  return <span className={cn("chat-inline-token", className)} data-kind={kind} data-gone={gone ? "" : undefined} title={label}>{content}</span>
}
