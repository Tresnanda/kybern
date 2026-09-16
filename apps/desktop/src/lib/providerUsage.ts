import type { ProviderUsage } from "@/protocol"

export function reportedPercent(value: number): number | null {
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : null
}

export function contextUsage(context?: ProviderUsage["context"]) {
  if (!context || !Number.isFinite(context.used_tokens) || !Number.isFinite(context.window_tokens) || context.used_tokens < 0 || context.window_tokens <= 0) return null
  return { used: context.used_tokens, window: context.window_tokens, percent: reportedPercent(context.used_tokens / context.window_tokens * 100)! }
}

// Friendly names for the raw limit kinds harnesses report (Claude passes some
// through verbatim, e.g. "seven_day_overage_included").
const LIMIT_NAME_LABELS: Record<string, string> = {
  five_hour: "5-hour",
  seven_day: "Weekly",
  seven_day_overage_included: "Weekly (with overage)",
}

export function limitLabel(limit: NonNullable<ProviderUsage["limits"]>[number]): string {
  if (limit.window_minutes === 300) return "5-hour"
  if (limit.window_minutes === 10080) return "Weekly"
  const name = limit.name?.trim()
  if (!name) return "Usage limit"
  if (LIMIT_NAME_LABELS[name]) return LIMIT_NAME_LABELS[name]
  // Humanize an unknown snake_case / camelCase kind into Title Case words.
  const words = name.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Usage limit"
}

export function resetLabel(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "Reset time unavailable"
  const date = new Date(seconds * 1000)
  if (!Number.isFinite(date.getTime())) return "Reset time unavailable"
  return `Resets ${date.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}`
}
