import type { JsonValue, PermissionMode, ProviderKind, ThreadStatus, ToolCall } from "@/protocol"

export function relativeTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ""
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 45) return "now"
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.round(h / 24)
  if (d < 7) return `${d}d`
  const w = Math.round(d / 7)
  if (w < 5) return `${w}w`
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

export function clockTime(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ""
  return new Date(t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
}

export function dayBucket(iso: string, now = Date.now()): "Today" | "Yesterday" | "This week" | "Earlier" {
  const t = new Date(iso)
  const n = new Date(now)
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const diffDays = Math.round((startOfDay(n) - startOfDay(t)) / 86_400_000)
  if (diffDays <= 0) return "Today"
  if (diffDays === 1) return "Yesterday"
  if (diffDays < 7) return "This week"
  return "Earlier"
}

export function duration(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms / 100) / 10)}s`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const r = s % 60
  if (m < 60) return r ? `${m}m ${r}s` : `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

export function elapsedSince(iso: string, now = Date.now()): number {
  const t = Date.parse(iso)
  return Number.isNaN(t) ? 0 : Math.max(0, now - t)
}

export function tokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

export function usd(n: number): string {
  return n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

export function shortenPath(p: string, keep = 3): string {
  const parts = p.split("/").filter(Boolean)
  return parts.length <= keep ? p : `…/${parts.slice(-keep).join("/")}`
}

export function basename(p: string): string {
  const parts = p.split("/").filter(Boolean)
  return parts[parts.length - 1] ?? p
}

export const PERMISSION_LABEL: Record<PermissionMode, string> = {
  supervised: "Supervised",
  "accept-edits": "Accept edits",
  auto: "Auto",
  "full-access": "Full access",
}

export const PERMISSION_HINT: Record<PermissionMode, string> = {
  supervised: "Asks before every edit, command, and network call.",
  "accept-edits": "Edits files freely. Asks before commands and network calls.",
  auto: "The agent decides and only asks when unsure.",
  "full-access": "Never asks. Use in a sandbox or a worktree.",
}

export const PROVIDER_LABEL: Record<ProviderKind, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  pi: "pi",
  omp: "Oh My Pi",
  cursor: "Cursor",
}

function str(input: JsonValue, key: string): string | undefined {
  if (!input || typeof input !== "object") return undefined
  const v = (input as Record<string, unknown>)[key]
  return typeof v === "string" ? v.split("\n")[0] : undefined
}

/** Verb + object line for a tool call, e.g. ["Ran", "git status"]. */
export function toolLine(call: ToolCall): { verb: string; detail: string; mono: boolean } {
  const name = call.name
  const lower = name.toLowerCase()
  const input = call.input
  if (["bash", "shell", "execute", "run"].includes(lower)) {
    return { verb: "Ran", detail: str(input, "command") ?? str(input, "cmd") ?? "", mono: true }
  }
  if (["write", "create"].includes(lower)) return { verb: "Wrote", detail: shortenPath(str(input, "file_path") ?? str(input, "path") ?? ""), mono: true }
  if (["edit", "multiedit", "apply_patch", "str_replace_editor", "patch"].includes(lower)) {
    const changes = (input as { changes?: { path?: string }[] } | null)?.changes
    const detail = Array.isArray(changes)
      ? changes.map((c) => shortenPath(c.path ?? "")).join(", ")
      : shortenPath(str(input, "file_path") ?? str(input, "path") ?? "")
    return { verb: "Edited", detail, mono: true }
  }
  if (lower === "read") return { verb: "Read", detail: shortenPath(str(input, "file_path") ?? str(input, "path") ?? ""), mono: true }
  if (["grep", "glob", "search", "ripgrep", "find"].includes(lower)) {
    return { verb: "Searched", detail: str(input, "pattern") ?? str(input, "query") ?? "", mono: true }
  }
  if (["webfetch", "fetch", "web_search", "websearch"].includes(lower)) return { verb: "Fetched", detail: str(input, "url") ?? str(input, "query") ?? "", mono: false }
  if (["task", "agent", "subagent"].includes(lower)) return { verb: "Delegated", detail: str(input, "description") ?? str(input, "prompt") ?? "", mono: false }
  if (["todowrite", "todo", "plan"].includes(lower)) return { verb: "Planned", detail: "", mono: false }
  const detail =
    str(input, "title") ?? str(input, "query") ?? str(input, "command") ?? str(input, "path") ?? str(input, "file_path") ?? ""
  return { verb: name, detail, mono: true }
}

export function outputText(output: JsonValue | null, stream: string): string {
  if (typeof output === "string") return output
  if (output && typeof output === "object") {
    const o = output as Record<string, unknown>
    for (const k of ["output", "stdout", "content", "text", "result"]) {
      const v = o[k]
      if (typeof v === "string") return v
    }
    return JSON.stringify(output, null, 2)
  }
  return stream
}

export const isMac = /Mac/.test(navigator.userAgent)
export const mod = isMac ? "⌘" : "Ctrl"

export const STATUS_LABEL: Record<ThreadStatus, string> = {
  idle: "",
  running: "Working",
  "awaiting-approval": "Needs approval",
  failed: "Failed",
  archived: "Archived",
}
