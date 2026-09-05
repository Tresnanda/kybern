// Harness-native screen control (Codex "Computer Use" and "Browser Use").
//
// Codex reports these as ordinary MCP tool calls from its bundled
// `cua_repl` server, tagged with `result._meta["codex/toolSurface"]`. The
// screenshot the action returned travels inside the MCP result as an inline
// image block. Nothing here is Codex-specific in the protocol sense: another
// harness that exposes the same shape renders the same way.

import type { JsonValue, ToolCall } from "@/protocol"
import { imageSource } from "./responseImages"

export type ToolSurfaceKind = "computer" | "browser"

export interface ToolSurface {
  kind: ToolSurfaceKind
  /** Bundle id of the app the harness drove, when it reported one. */
  appId: string | null
  /** App name for people: reported by the harness, or derived from the bundle id. */
  app: string | null
  /** Screenshots the action returned, as data URLs, in order. */
  screenshots: string[]
}

const APP_NAMES: Record<string, string> = {
  "com.openai.codex": "ChatGPT",
  "com.openai.chat": "ChatGPT",
  "com.anthropic.claudefordesktop": "Claude",
  "com.apple.finder": "Finder",
  "com.apple.Safari": "Safari",
  "com.apple.Terminal": "Terminal",
  "com.apple.systempreferences": "System Settings",
  "com.apple.iphonesimulator": "Simulator",
  "com.apple.dt.Xcode": "Xcode",
  "com.apple.mail": "Mail",
  "com.apple.Notes": "Notes",
  "com.apple.Preview": "Preview",
  "com.google.Chrome": "Google Chrome",
  "com.brave.Browser": "Brave",
  "company.thebrowser.Browser": "Arc",
  "org.mozilla.firefox": "Firefox",
  "com.microsoft.edgemac": "Microsoft Edge",
  "com.microsoft.VSCode": "Visual Studio Code",
  "com.todesktop.230313mzl4w4u92": "Cursor",
  "com.googlecode.iterm2": "iTerm",
  "com.mitchellh.ghostty": "Ghostty",
  "dev.warp.Warp-Stable": "Warp",
  "com.tinyspeck.slackmacgap": "Slack",
  "com.hnc.Discord": "Discord",
  "net.whatsapp.WhatsApp": "WhatsApp",
  "com.figma.Desktop": "Figma",
  "notion.id": "Notion",
  "com.linear": "Linear",
  "com.spotify.client": "Spotify",
}

/** Best-effort app name for a bundle id: known apps by table, the rest by their last segment. */
export function appDisplayName(appId: string): string {
  const known = APP_NAMES[appId]
  if (known) return known
  const leaf = appId.split(".").filter(Boolean).at(-1) ?? appId
  return leaf.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const string = (value: unknown): string => (typeof value === "string" ? value : "")

/** The name Codex gives its screen-control server, and the generic shapes other harnesses use. */
function surfaceFromName(name: string): ToolSurfaceKind | null {
  const lower = name.toLowerCase()
  if (/(^|[:/_])cua([_:/]|$)|computer[_ -]?use/.test(lower)) return "computer"
  if (/browser[_ -]?use/.test(lower)) return "browser"
  return null
}

function surfaceFromMeta(output: JsonValue | null): { kind: ToolSurfaceKind; app: Record<string, unknown> } | null {
  const outer = record(output)
  const result = record(outer.result)
  const meta = record(result._meta ?? outer._meta)
  const surface = record(meta["codex/toolSurface"])
  const kind = string(surface.kind)
  if (kind === "computerUse") return { kind: "computer", app: record(surface.app) }
  if (kind === "browserUse") return { kind: "browser", app: record(surface.app) }
  return null
}

function screenshotsFrom(output: JsonValue | null): string[] {
  const outer = record(output)
  const content = record(outer.result).content ?? outer.content
  if (!Array.isArray(content)) return []
  const out: string[] = []
  for (const item of content) {
    const block = record(item)
    const mime = string(block.mimeType ?? block.media_type ?? block.mime)
    if (block.type !== "image" || typeof block.data !== "string" || !mime.startsWith("image/")) continue
    const source = `data:${mime};base64,${block.data}`
    if (imageSource(source)) out.push(source)
  }
  return out
}

/** Detect a screen-control call from its name (while it runs) or its result (once settled). */
export function toolSurface(call: ToolCall, output: JsonValue | null = null): ToolSurface | null {
  const fromMeta = surfaceFromMeta(output)
  const kind = fromMeta?.kind ?? surfaceFromName(call.name)
  if (!kind) return null
  const app = fromMeta?.app ?? {}
  const code = string(record(call.input).code)
  const appId =
    string(app.appId) ||
    string(app.bundleId) ||
    (/getApp\(\s*["']([^"']+)["']\s*\)/.exec(code)?.[1] ?? "") ||
    null
  const name = string(app.displayName) || (appId ? appDisplayName(appId) : "")
  return { kind, appId, app: name || null, screenshots: screenshotsFrom(output) }
}

/** The action's textual result without the inline image payloads or JSON scaffolding. */
export function surfaceOutputText(output: JsonValue | null): string {
  const outer = record(output)
  const content = record(outer.result).content ?? outer.content
  if (Array.isArray(content)) {
    const text = content
      .map((item) => record(item))
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => String(block.text).trim())
      .filter(Boolean)
      .join("\n\n")
    if (text) return text
  }
  const error = outer.error
  if (typeof error === "string") return error
  const message = string(record(error).message)
  return message
}
