// Inline chip for a `$skill`, `@plugin`, `@thread`, `@file` or `@image1` token inside message text.
// Used in sent bubbles (with an icon) and, in `plain` mode, inside the composer's
// highlight layer where it must keep the exact metrics of the raw text.

import { FileEntryIcon } from "@/components/kit/chat/FileEntryIcon"
import { MessageCircleIcon, PluginIcon, SkillCubeIcon } from "@/lib/kit/icons"
import { cn } from "@/lib/utils"

export type InlineTokenKind = "skill" | "plugin" | "thread" | "file" | "attachment"

export interface InlineTokenDescriptor {
  kind: InlineTokenKind
  onClick?: () => void
  label?: string
}

export function InlineToken({ kind, text, plain = false, className, onClick, label }: { kind: InlineTokenKind; text: string; plain?: boolean; className?: string; onClick?: () => void; label?: string }) {
  const content = (
    <>
      {!plain && (kind === "skill" ? <SkillCubeIcon aria-hidden /> : kind === "plugin" ? <PluginIcon aria-hidden /> : kind === "thread" ? <MessageCircleIcon aria-hidden /> : kind === "attachment" ? <FileEntryIcon pathValue={text.slice(1)} kind="file" mimeType={text.startsWith("@image") ? "image/png" : null} /> : <FileEntryIcon pathValue={text.slice(1)} kind="file" />)}
      {text}
    </>
  )
  if (onClick && !plain) return <button type="button" className={cn("chat-inline-token cursor-pointer outline-hidden focus-visible:ring-1 focus-visible:ring-ring", className)} data-kind={kind} onClick={onClick} aria-label={label} title={label}>{content}</button>
  return <span className={cn("chat-inline-token", className)} data-kind={kind} data-plain={plain || undefined}>{content}</span>
}
