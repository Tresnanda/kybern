import type { IdleCompaction, PromptCache, ProviderInstance, ProviderKind, Settings } from "@/protocol"

export interface PromptCacheWindow {
  ttlMinutes: number
  providerLabel: string
  /** When the cache of the latest turn's last request expires, in ms since the epoch. */
  expiresAt: number
}

const LABELS: Partial<Record<ProviderKind, string>> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  pi: "pi",
  omp: "Oh My Pi",
}

/** Threads at or above this context size are compacted before their cache expires (the daemon's `IDLE_COMPACTION_TOKENS`). */
export const IDLE_COMPACTION_TOKENS = 200_000
/** How long before the cache expires the daemon sends the compaction. */
const IDLE_COMPACTION_LEAD_MS = 2 * 60_000

function enabled(value: string | undefined): boolean {
  return !!value && !["0", "false", "no", "off"].includes(value.trim().toLowerCase())
}

/** A daemon older than recorded expiries: the provider's documented window from the end of the last turn. */
function legacyTtlMinutes(provider: ProviderKind, env: Record<string, string>): number | null {
  if (provider === "codex") return 30
  if (provider !== "claude-code") return null
  if (enabled(env.FORCE_PROMPT_CACHING_5M)) return 5
  const configured = env.CLAUDE_CODE_PROMPT_CACHE_TTL?.trim().toLowerCase()
  return configured === "1h" || enabled(env.ENABLE_PROMPT_CACHING_1H) ? 60 : 5
}

/**
 * The prompt cache of a thread's latest turn. The daemon records it with each
 * turn: Claude Code's own TTL, or the documented one for harnesses that do not
 * say. A recorded cache without a TTL is unknown and shows no countdown.
 */
export function promptCacheWindow(
  provider: ProviderKind | undefined,
  recorded: PromptCache | undefined,
  lastActivityAt: string | undefined,
  env: Record<string, string> = {},
): PromptCacheWindow | null {
  const providerLabel = provider ? LABELS[provider] : undefined
  if (!provider || !providerLabel) return null
  if (recorded) {
    const expiresAt = recorded.expires_at ? Date.parse(recorded.expires_at) : NaN
    if (!recorded.ttl_seconds || !Number.isFinite(expiresAt)) return null
    return { ttlMinutes: recorded.ttl_seconds / 60, providerLabel, expiresAt }
  }
  const ttlMinutes = legacyTtlMinutes(provider, env)
  const lastActivity = lastActivityAt ? Date.parse(lastActivityAt) : NaN
  if (ttlMinutes === null || !Number.isFinite(lastActivity)) return null
  return { ttlMinutes, providerLabel, expiresAt: lastActivity + ttlMinutes * 60_000 }
}

export function promptCacheRemainingMinutes(window: PromptCacheWindow, now = Date.now()): number {
  return Math.min(Math.ceil(window.ttlMinutes), Math.max(0, Math.ceil((window.expiresAt - now) / 60_000)))
}

/** "1-hour", "5-minute", "30-minute". */
export function cacheLengthLabel(ttlMinutes: number): string {
  if (ttlMinutes >= 60 && ttlMinutes % 60 === 0) return `${ttlMinutes / 60}-hour`
  return `${Math.round(ttlMinutes)}-minute`
}

/** "Compact idle threads" for an account: its own choice, else the global one. */
export function idleCompactionFor(settings: Settings | null | undefined, provider: Pick<ProviderInstance, "kind" | "instance">): IdleCompaction {
  return settings?.providers[provider.kind]?.idle_compaction?.[provider.instance] ?? settings?.compaction?.idle ?? "when_you_return"
}

/** Harnesses the daemon compacts on its own schedule (`supports_idle_compaction`). */
export function supportsIdleCompaction(kind: ProviderKind): boolean {
  return kind === "claude-code" || kind === "codex" || kind === "opencode" || kind === "pi" || kind === "omp"
}

/** When Kybern compacts this thread if it stays idle, or `null` when it will not. */
export function idleCompactionAt(window: PromptCacheWindow, mode: IdleCompaction, kind: ProviderKind, contextTokens: number | null, now = Date.now()): number | null {
  if (mode !== "before_cache_expires" || !supportsIdleCompaction(kind) || contextTokens === null || contextTokens < IDLE_COMPACTION_TOKENS) return null
  const at = window.expiresAt - IDLE_COMPACTION_LEAD_MS
  return window.expiresAt - 30_000 > now ? Math.max(at, now) : null
}

/** The popover caption under "Prompt cache". `compactAt` is a local clock time such as "14:58". */
export function promptCacheCaption(window: PromptCacheWindow, state: "active" | "warm" | "cold", remaining: number, compactAt: string | null): string {
  const length = cacheLengthLabel(window.ttlMinutes)
  if (state === "active") return `${window.providerLabel} is actively using this conversation.`
  if (state === "cold") return `This thread’s ${length} cache has expired.`
  const left = `This thread’s ${length} cache has about ${remaining} minute${remaining === 1 ? "" : "s"} left.`
  return compactAt ? `${left} Kybern compacts it at ${compactAt} if you’re away.` : left
}
