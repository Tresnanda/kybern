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
 * The account's color as a small dot. It never sits on an agent mark: beside a
 * mark use AccountMarkStack, which places it at the mark's top-right.
 */
export function AccountDot({ color, className }: { color?: string | null; className?: string }) {
  const fill = accountColorVar(color)
  if (!fill) return null
  return <span aria-hidden data-account-dot={color} className={cn("size-1.5 shrink-0 rounded-full", className)} style={{ backgroundColor: fill }} />
}

/**
 * The agent mark with the account's dot beside it at the top-right, never on
 * the mark. The CLI account and accounts without a color show the mark alone.
 */
export function AccountMarkStack({ kind, color, size = 14, className }: { kind: ProviderKind; color?: string | null; size?: number; className?: string }) {
  return (
    <span className={cn("inline-flex shrink-0 items-start", className)}>
      <ProviderMark kind={kind} size={size} />
      <AccountDot color={color} className="ms-px" />
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
