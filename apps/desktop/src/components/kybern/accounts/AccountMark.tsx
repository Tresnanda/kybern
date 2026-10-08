// Marks that tell one account of an agent apart from another: the color dot,
// the agent mark with its dot, and the avatar tile. The CLI account and any
// account without a known color never show a dot.

import { ProviderMark } from "@/components/kybern/bits"
import { accountColorVar, isCliInstance } from "@/lib/accounts"
import { cn } from "@/lib/utils"
import type { ProviderKind } from "@/protocol"

// The helpers live in lib/accounts.ts so node tests can load them; this keeps
// the names where the components are.
// eslint-disable-next-line react-refresh/only-export-components
export { ACCOUNT_COLORS, ACCOUNT_COLOR_LABELS, accountDisplayName, nextFreeColor, type AccountColor } from "@/lib/accounts"

/**
 * An 8px dot with a ring in the surface color, so it reads as cut out of the
 * agent mark. Position it with `absolute -end-0.5 -bottom-0.5` (AccountMarkStack does).
 * Set `--account-dot-ring` on a parent when the surface is not the page background.
 */
export function AccountDot({ color, className }: { color?: string | null; className?: string }) {
  const fill = accountColorVar(color)
  if (!fill) return null
  return <span aria-hidden data-account-dot={color} className={cn("size-2 shrink-0 rounded-full ring-2 ring-[color:var(--account-dot-ring,var(--color-background-elevated-primary-opaque))]", className)} style={{ backgroundColor: fill }} />
}

/** The agent mark with the account's dot at its bottom-right. */
export function AccountMarkStack({ kind, color, size = 14, className }: { kind: ProviderKind; color?: string | null; size?: number; className?: string }) {
  return (
    <span className={cn("relative inline-flex shrink-0", className)}>
      <ProviderMark kind={kind} size={size} />
      <AccountDot color={color} className="absolute -end-0.5 -bottom-0.5" />
    </span>
  )
}

/** A rounded tile tinted with the account color, with the agent mark in its center. */
export function AccountAvatar({ kind, color, instance, size = 28, className }: { kind: ProviderKind; color?: string | null; instance?: string | null; size?: 20 | 28 | 32; className?: string }) {
  const fill = isCliInstance(instance) ? null : accountColorVar(color)
  return (
    <span
      aria-hidden
      className={cn("inline-flex shrink-0 items-center justify-center", size === 20 ? "rounded-md" : "rounded-lg", !fill && "bg-[var(--color-background-button-secondary)] ring-1 ring-inset ring-[color:var(--color-border)]", className)}
      style={{
        width: size,
        height: size,
        ...(fill ? { backgroundColor: `color-mix(in srgb, ${fill} 14%, transparent)`, boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${fill} 40%, transparent)` } : {}),
      }}
    >
      <ProviderMark kind={kind} size={Math.round(size * 0.5)} />
    </span>
  )
}
