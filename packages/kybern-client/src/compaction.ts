// Words for compaction (issue #295): the "Compact idle threads" and "Auto-compact at"
// settings, and the transcript notice an idle compaction leaves. GPUIX and mobile
// print the same text.
import type { IdleCompactionBlock } from "./transcript.ts"
import type { IdleCompaction, ProviderKind } from "./types.ts"

export const IDLE_COMPACTION_OPTIONS: readonly { value: IdleCompaction; label: string; description: string }[] = [
  {
    value: "when_you_return",
    label: "When you return",
    description: "When you come back to a long thread after its cache expired, the agent offers to compact it first.",
  },
  {
    value: "before_cache_expires",
    label: "Before the cache expires",
    description: "Threads over 200K tokens are compacted about 2 minutes before their prompt cache expires, while the history is still cached.",
  },
  {
    value: "never",
    label: "Never",
    description: "Threads keep their full history. Claude won’t ask again on this account, even if you change this later.",
  },
]

export function idleCompactionLabel(mode: IdleCompaction): string {
  return IDLE_COMPACTION_OPTIONS.find((option) => option.value === mode)?.label ?? IDLE_COMPACTION_OPTIONS[0]!.label
}

/** The account row's detail when it overrides the global choice ("Compacts before the cache expires"). */
export function idleCompactionDetail(mode: IdleCompaction): string {
  return mode === "before_cache_expires" ? "Compacts before the cache expires" : mode === "never" ? "Never compacts idle threads" : "Compacts when you return"
}

/** Thresholds offered for "Auto-compact at", in tokens. `null` keeps each agent's own limit. */
export const AUTO_COMPACT_CHOICES: readonly (number | null)[] = [null, 100_000, 150_000, 200_000, 300_000, 400_000, 500_000, 750_000, 1_000_000]

/** Harnesses whose own auto-compact limit Kybern can set (`autoCompactWindow`, `model_auto_compact_token_limit`,
 * `compaction.buffer`, `compaction.thresholdTokens`). Pi, Cursor, Antigravity and Grok Build have none. */
export const AUTO_COMPACT_HARNESSES: readonly ProviderKind[] = ["claude-code", "codex", "opencode", "omp"]

/** Harnesses Kybern can compact before their cache expires (the daemon's `supports_idle_compaction`). */
export const IDLE_COMPACTION_HARNESSES: readonly ProviderKind[] = ["claude-code", "codex", "opencode", "pi", "omp"]

/** 312 000 → "312K", 1 000 000 → "1M", 750 → "750". */
export function tokenSize(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0"
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1).replace(/\.0$/, "")}M`
  }
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`
  return String(Math.round(tokens))
}

export function autoCompactLabel(tokens: number | null | undefined): string {
  return tokens ? tokenSize(tokens) : "Default"
}

export const IDLE_COMPACTION_COPY = {
  running: "Compacting…",
  title: "Compacted",
  failedTitle: "Not compacted",
  body: "Your next message starts from a summary instead of re-reading the whole thread.",
  failedBody: "The thread keeps its full history. Send a message to continue.",
  settings: "Change in Settings",
} as const

/** The row's label: "Compacting…", then "Compacted while you were away · 14:58". */
export function idleCompactionRowLabel(block: Pick<IdleCompactionBlock, "finishedAt" | "failed">, time: string): string {
  if (!block.finishedAt) return IDLE_COMPACTION_COPY.running
  return block.failed ? `Couldn’t compact while you were away · ${time}` : `Compacted while you were away · ${time}`
}

/** "312K → 38K tokens · 2 minutes before the 1-hour cache expired". */
export function idleCompactionMeta(block: Pick<IdleCompactionBlock, "contextTokens" | "contextAfter" | "cacheExpiresAt" | "cacheTtlSeconds" | "at">): string {
  const size = block.contextAfter !== null ? `${tokenSize(block.contextTokens)} → ${tokenSize(block.contextAfter)} tokens` : `${tokenSize(block.contextTokens)} tokens`
  const lead = Math.max(1, Math.round((Date.parse(block.cacheExpiresAt) - Date.parse(block.at)) / 60_000))
  const ttl = block.cacheTtlSeconds
  const cache = ttl ? (ttl % 3600 === 0 ? `${ttl / 3600}-hour cache` : `${Math.round(ttl / 60)}-minute cache`) : "cache"
  if (!Number.isFinite(lead)) return size
  return `${size} · ${lead} minute${lead === 1 ? "" : "s"} before the ${cache} expired`
}

/** Turns Kybern started to compact an idle thread. Their end is not news: no unread
 * mark, toast or notification, only the thread's notice row. One per follower. */
export class IdleCompactionTurns {
  private readonly turns = new Set<string>()

  /** Whether the event belongs to an idle compaction and should pass silently. */
  silent(event: { kind: string; turn_id?: string | null }): boolean {
    if (event.kind === "idle_compaction_started") {
      if (event.turn_id) this.turns.add(event.turn_id)
      if (this.turns.size > 64) this.turns.delete(this.turns.values().next().value!)
      return true
    }
    if ((event.kind === "turn_completed" || event.kind === "turn_failed") && event.turn_id) return this.turns.delete(event.turn_id)
    return false
  }
}
