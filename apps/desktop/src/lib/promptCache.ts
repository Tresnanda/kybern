import type { ProviderKind } from "@/protocol"

export interface PromptCacheWindow {
  ttlMinutes: number
  providerLabel: string
}

function enabled(value: string | undefined): boolean {
  return !!value && !["0", "false", "no", "off"].includes(value.trim().toLowerCase())
}

/**
 * Provider-documented prompt-cache windows. These are useful warm-window
 * estimates, not eviction guarantees: providers may retain entries longer and
 * do not consistently expose an exact expiry timestamp.
 */
export function promptCacheWindow(
  provider: ProviderKind | undefined,
  env: Record<string, string> = {},
): PromptCacheWindow | null {
  if (provider === "codex") return { ttlMinutes: 30, providerLabel: "Codex" }
  if (provider !== "claude-code") return null

  if (enabled(env.FORCE_PROMPT_CACHING_5M)) {
    return { ttlMinutes: 5, providerLabel: "Claude Code" }
  }
  const configured = env.CLAUDE_CODE_PROMPT_CACHE_TTL?.trim().toLowerCase()
  if (configured === "1h" || enabled(env.ENABLE_PROMPT_CACHING_1H)) {
    return { ttlMinutes: 60, providerLabel: "Claude Code" }
  }
  return { ttlMinutes: 5, providerLabel: "Claude Code" }
}

export function promptCacheRemainingMinutes(
  lastActivityAt: string,
  ttlMinutes: number,
  now = Date.now(),
): number {
  const lastActivity = Date.parse(lastActivityAt)
  if (!Number.isFinite(lastActivity)) return 0
  return Math.min(
    ttlMinutes,
    Math.max(0, Math.ceil((lastActivity + ttlMinutes * 60_000 - now) / 60_000)),
  )
}
