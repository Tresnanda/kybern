// FILE: ComposerModelTriggerLabel.tsx
// Purpose: What the composer's model trigger reads, in order: the agent mark,
// the account's color dot beside it (never on it), the account name when the
// thread uses a named account, the model, a bolt when fast mode is on, the
// effort and any other changed trait (`1M`), then the chevron. The CLI
// account shows no dot and no name.
// Layer: Composer UI
// Exports: ComposerModelTriggerLabel

import { COMPOSER_MUTED_ACCENT_TEXT_CLASS_NAME } from "@/components/kit/chat/composerPickerStyles"
import { AccountDot } from "@/components/kybern/accounts/AccountMark"
import { ProviderMark } from "@/components/kybern/bits"
import { ChevronDownIcon, FastModeIcon } from "@/lib/kit/icons"
import { cn } from "@/lib/utils"
import type { ProviderKind } from "@/protocol"

// Cap-height trim centers the text optically; the 2px padding keeps descenders
// inside the box that `truncate` clips.
const TEXT = "leading-none [text-box-trim:trim-both] [text-box-edge:cap_alphabetic] -my-0.5 py-0.5"

export function ComposerModelTriggerLabel({ kind, account, model, qualifier, fast, effort, traits, chevron }: {
  kind: ProviderKind
  /** A named account the thread uses; null for the CLI account. */
  account: { name: string; color?: string | null } | null
  model: string
  qualifier: string | null
  fast: boolean
  /** Formatted effort ("High"), shown only next to a model. */
  effort: string | null
  /** Other traits that differ from the model's defaults ("1M"). */
  traits: string[]
  chevron: boolean
}) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
      <ProviderMark kind={kind} size={14} className="size-3.5 shrink-0 text-[var(--color-text-foreground)] opacity-100" />
      {account && <AccountDot color={account.color} className="-ms-1 self-start" />}
      {account && <span className={cn("max-w-24 shrink-0 truncate", TEXT, COMPOSER_MUTED_ACCENT_TEXT_CLASS_NAME, "@max-[480px]:hidden")}><bdi>{account.name}</bdi></span>}
      <span className={cn("min-w-0 truncate text-[var(--color-text-foreground)]", TEXT, "@max-[360px]:hidden")}>{model}</span>
      {qualifier && <span className={cn("shrink-0", TEXT, COMPOSER_MUTED_ACCENT_TEXT_CLASS_NAME, "@max-[480px]:hidden")}>{qualifier}</span>}
      {fast && <FastModeIcon aria-hidden className="size-3.5 shrink-0 text-[var(--color-text-foreground)] opacity-100" />}
      {effort && <span className={cn("shrink-0", TEXT, COMPOSER_MUTED_ACCENT_TEXT_CLASS_NAME, "@max-[620px]:hidden")}>{effort}</span>}
      {traits.length > 0 && <span className={cn("shrink-0", TEXT, COMPOSER_MUTED_ACCENT_TEXT_CLASS_NAME, "@max-[620px]:hidden")}>{traits.join(" · ")}</span>}
      {chevron && <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" />}
    </span>
  )
}
