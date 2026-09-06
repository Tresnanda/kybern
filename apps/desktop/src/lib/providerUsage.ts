import type { ProviderUsage } from "@/protocol"

export function reportedPercent(value: number): number | null {
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : null
}

export function contextUsage(context?: ProviderUsage["context"]) {
  if (!context || !Number.isFinite(context.used_tokens) || !Number.isFinite(context.window_tokens) || context.used_tokens < 0 || context.window_tokens <= 0) return null
  return { used: context.used_tokens, window: context.window_tokens, percent: reportedPercent(context.used_tokens / context.window_tokens * 100)! }
}

export function limitLabel(limit: NonNullable<ProviderUsage["limits"]>[number]): string {
  if (limit.window_minutes === 300) return "5-hour"
  if (limit.window_minutes === 10080) return "Weekly"
  return limit.name || "Usage limit"
}

export function resetLabel(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "Reset time unavailable"
  const date = new Date(seconds * 1000)
  if (!Number.isFinite(date.getTime())) return "Reset time unavailable"
  return `Resets ${date.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}`
}
