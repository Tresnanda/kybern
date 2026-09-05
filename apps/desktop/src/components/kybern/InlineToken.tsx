// Inline chip for a `$skill`, `@plugin` or `@file` token inside message text.
// Used in sent bubbles (with an icon) and, in `plain` mode, inside the composer's
// highlight layer where it must keep the exact metrics of the raw text.

import { FileEntryIcon } from "@/components/kit/chat/FileEntryIcon"
import { PluginIcon, SkillCubeIcon } from "@/lib/kit/icons"
import { cn } from "@/lib/utils"

export type InlineTokenKind = "skill" | "plugin" | "file"

export function InlineToken({ kind, text, plain = false, className }: { kind: InlineTokenKind; text: string; plain?: boolean; className?: string }) {
  return (
    <span className={cn("chat-inline-token", className)} data-kind={kind} data-plain={plain || undefined}>
      {!plain && (kind === "skill" ? <SkillCubeIcon aria-hidden /> : kind === "plugin" ? <PluginIcon aria-hidden /> : <FileEntryIcon pathValue={text.slice(1)} kind="file" />)}
      {text}
    </span>
  )
}
