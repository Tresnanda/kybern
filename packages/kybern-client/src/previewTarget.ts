/**
 * Address-bar classification for the in-app preview (ADE-34 spec section 2).
 * Pure: the daemon re-validates everything it serves.
 */

export type PreviewContext = {
  /** Absolute project root; relative paths resolve against it. */
  projectRoot?: string
  /** Shown as the first crumb for files inside the project. */
  projectName?: string
  /** Absolute home directory used to expand `~`. */
  home?: string
}

export type PreviewServerScope = "loopback" | "private"

export type PreviewTarget =
  | {
      kind: "file"
      /** Absolute when a root/home is known, otherwise as typed (normalized). */
      path: string
      /** Path relative to the project root when the file is inside it. */
      relative?: string
    }
  | {
      kind: "server"
      url: string
      /** `hostname[:port]`, IPv6 hosts keep their brackets. */
      host: string
      hostname: string
      port?: number
      scope: PreviewServerScope
    }
  | { kind: "external"; url: string; host: string }
  | { kind: "search"; query: string }
  | { kind: "rejected"; reason: "scheme" | "invalid" }
  | { kind: "empty" }

export type PreviewDisplaySegment = { text: string; emphasis: boolean }
export type PreviewDisplay = {
  segments: PreviewDisplaySegment[]
  /** Full value for `title` and the focused address bar. */
  full: string
}

export const PREVIEW_REJECTED_MESSAGE = "Kybern can't open this kind of address."
export const PREVIEW_CRUMB = "›"

const REJECTED_SCHEMES = new Set([
  "javascript",
  "data",
  "blob",
  "about",
  "tauri",
  "ipc",
  "kybern",
  "vbscript",
  "chrome",
  "view-source",
  "ftp",
  "mailto",
  "ws",
  "wss",
])

const HOST_FORM =
  /^(?:[^\s/@?#]+@)?(?:\[[0-9a-f:.]+\]|[a-z0-9_-]+(?:\.[a-z0-9_-]+)*)(?::\d{1,5})?(?:[/?#].*)?$/i
const PORT_FORM = /^[^\s:/\\]+:\d{1,5}(?:[/?#]|$)/
const SCHEME = /^([a-z][a-z0-9+.-]*):/i

export function classifyPreviewInput(input: string, context: PreviewContext = {}): PreviewTarget {
  const text = input.trim()
  if (!text) return { kind: "empty" }
  if (/[\u0000-\u001f]/.test(text)) return { kind: "rejected", reason: "invalid" }

  // Bare port: `5173` or `:5173`.
  const bare = /^:?(\d{1,5})$/.exec(text)
  if (bare) {
    const port = Number(bare[1])
    if (port >= 1 && port <= 65535) return serverTarget(`http://localhost:${port}`) ?? search(text)
    return search(text)
  }

  const scheme = SCHEME.exec(text)?.[1].toLowerCase()
  if (scheme && REJECTED_SCHEMES.has(scheme)) return { kind: "rejected", reason: "scheme" }

  if (scheme === "file") return fileFromUrl(text, context)
  if (scheme === "http" || scheme === "https") {
    if (/^https?:\/\/[^/]*\\/i.test(text)) return { kind: "rejected", reason: "invalid" }
    return urlTarget(text)
  }
  // `C:\dir\x.html` is a path, not a scheme.
  if (scheme && scheme.length === 1 && /^[a-z]:[\\/]/i.test(text)) return fileTarget(text, context)
  // `localhost:3000` looks like a scheme but is a host and port.
  if (scheme && !PORT_FORM.test(text)) {
    return text.includes("//") ? { kind: "rejected", reason: "scheme" } : search(text)
  }

  if (text.startsWith("//")) return { kind: "rejected", reason: "invalid" }
  if (isPathInput(text)) return fileTarget(text, context)
  if (!/\s/.test(text) && HOST_FORM.test(text) && (text.includes(":") || hostHasDot(text) || /^localhost(?:[/?#]|$)/i.test(text))) {
    return urlTarget(`http://${text}`)
  }
  return search(text)
}

function search(query: string): PreviewTarget {
  return { kind: "search", query }
}

function hostHasDot(text: string): boolean {
  const withoutUser = text.slice(text.lastIndexOf("@", authorityEnd(text)) + 1)
  return /^[^/?#:]*\./.test(withoutUser)
}

function authorityEnd(text: string): number {
  const end = text.search(/[/?#]/)
  return end < 0 ? text.length : end
}

function isPathInput(text: string): boolean {
  if (text.startsWith("/") || text.startsWith("~") || text.startsWith("./") || text.startsWith("../")) return true
  const bare = text.split(/[?#]/)[0]
  if (!/\.(?:html?|svg)$/i.test(bare)) return false
  if (!bare.includes("/")) return true
  // `example.com/page.html` is a site; `mock/index.html` and `v1.2/x.html` are files.
  const first = bare.split("/")[0]
  return !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(first)
}

function urlTarget(raw: string): PreviewTarget {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { kind: "rejected", reason: "invalid" }
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { kind: "rejected", reason: "scheme" }
  if (!url.hostname) return { kind: "rejected", reason: "invalid" }
  // Classify by the real host, never the userinfo (`http://127.0.0.1@evil.com`).
  return (
    serverTarget(url.href) ?? { kind: "external", url: url.href, host: url.host }
  )
}

/** Returns a server target when the URL's real host is loopback or private. */
function serverTarget(raw: string): PreviewTarget | undefined {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  const scope = hostScope(url.hostname)
  if (!scope) return undefined
  return {
    kind: "server",
    url: url.href,
    host: url.host,
    hostname: url.hostname,
    ...(url.port ? { port: Number(url.port) } : {}),
    scope,
  }
}

export function hostScope(hostname: string): PreviewServerScope | undefined {
  const host = hostname.toLowerCase().replace(/\.$/, "")
  if (host === "localhost" || host.endsWith(".localhost")) return "loopback"
  if (host.startsWith("[")) return ipv6Scope(host.slice(1, -1))
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if (a === 127 || (a === 0 && b === 0 && Number(v4[3]) === 0 && Number(v4[4]) === 0)) return "loopback"
    if (a === 10) return "private"
    if (a === 172 && b >= 16 && b <= 31) return "private"
    if (a === 192 && b === 168) return "private"
    if (a === 100 && b >= 64 && b <= 127) return "private"
    return undefined
  }
  if (host.endsWith(".local")) return "private"
  return undefined
}

function ipv6Scope(addr: string): PreviewServerScope | undefined {
  if (addr === "::1" || addr === "::") return "loopback"
  // IPv4-mapped (`::ffff:7f00:1` after URL normalization, or dotted).
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(addr)
  if (mapped) {
    const hi = parseInt(mapped[1], 16)
    const lo = parseInt(mapped[2], 16)
    return hostScope(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
  }
  return undefined
}

function fileFromUrl(text: string, context: PreviewContext): PreviewTarget {
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return { kind: "rejected", reason: "invalid" }
  }
  if (url.host && url.host !== "localhost") return { kind: "rejected", reason: "invalid" }
  let path: string
  try {
    path = decodeURIComponent(url.pathname)
  } catch {
    return { kind: "rejected", reason: "invalid" }
  }
  if (path.includes("\u0000")) return { kind: "rejected", reason: "invalid" }
  return fileTarget(path, context)
}

function fileTarget(raw: string, context: PreviewContext): PreviewTarget {
  let path = raw.split(/[?#]/)[0]
  if (!path) return { kind: "rejected", reason: "invalid" }
  if (path === "~" || path.startsWith("~/")) {
    if (context.home) path = `${trimSlash(context.home)}${path.slice(1)}`
  } else if (!path.startsWith("/") && !/^[a-z]:[\\/]/i.test(path) && context.projectRoot) {
    path = `${trimSlash(context.projectRoot)}/${path}`
  }
  path = normalizePath(path)
  const root = context.projectRoot ? normalizePath(context.projectRoot) : undefined
  const relative = root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : undefined
  return { kind: "file", path, ...(relative ? { relative } : {}) }
}

function trimSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path
}

function normalizePath(path: string): string {
  const absolute = path.startsWith("/")
  const out: string[] = []
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue
    if (part === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop()
      else if (!absolute) out.push("..")
    } else out.push(part)
  }
  const joined = out.join("/")
  return absolute ? `/${joined}` : joined
}

/**
 * Address bar rest-state text (spec 3.2): no scheme, server host+port in the
 * foreground and the path muted, files as `project › dir/file` or
 * `…/folder/file` outside the project.
 */
export function previewDisplay(target: PreviewTarget, context: PreviewContext = {}): PreviewDisplay {
  switch (target.kind) {
    case "server": {
      const url = new URL(target.url)
      const tail = `${url.pathname === "/" ? "" : url.pathname}${url.search}${url.hash}`
      return {
        segments: tail
          ? [{ text: target.host, emphasis: true }, { text: tail, emphasis: false }]
          : [{ text: target.host, emphasis: true }],
        full: target.url,
      }
    }
    case "file": {
      if (target.relative) {
        const parts = target.relative.split("/")
        const name = parts.pop() ?? target.relative
        const lead = [context.projectName, ...parts].filter(Boolean)
        const crumb = lead.length ? `${lead.join(` ${PREVIEW_CRUMB} `)} ${PREVIEW_CRUMB} ` : ""
        return {
          segments: crumb
            ? [{ text: crumb, emphasis: false }, { text: name, emphasis: true }]
            : [{ text: name, emphasis: true }],
          full: target.path,
        }
      }
      const parts = target.path.split("/").filter(Boolean)
      const name = parts.pop() ?? target.path
      const folder = parts.pop()
      return {
        segments: folder
          ? [{ text: `…/${folder}/`, emphasis: false }, { text: name, emphasis: true }]
          : [{ text: name, emphasis: true }],
        full: target.path,
      }
    }
    case "external":
      return { segments: [{ text: target.host, emphasis: true }], full: target.url }
    case "search":
      return { segments: [{ text: target.query, emphasis: true }], full: target.query }
    default:
      return { segments: [], full: "" }
  }
}

export const PREVIEW_BRIDGE_SOURCE = "kybern-preview"
export const PREVIEW_BRIDGE_MAX_PATH = 2048
export const PREVIEW_BRIDGE_MAX_TITLE = 256

export type PreviewBridgeMessage =
  | { source: "kybern-preview"; type: "nav-start" }
  | {
      source: "kybern-preview"
      type: "nav"
      path: string
      title: string
      back: number
      forward: number
    }

/** Validates a `message` payload from a file preview (spec 5.4); null drops it. */
export function validateBridgeMessage(data: unknown): PreviewBridgeMessage | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null
  const m = data as Record<string, unknown>
  if (m.source !== PREVIEW_BRIDGE_SOURCE) return null
  if (m.type === "nav-start") return { source: PREVIEW_BRIDGE_SOURCE, type: "nav-start" }
  if (m.type !== "nav") return null
  const { path, title, back, forward } = m
  if (typeof path !== "string" || path.length > PREVIEW_BRIDGE_MAX_PATH) return null
  if (typeof title !== "string" || title.length > PREVIEW_BRIDGE_MAX_TITLE) return null
  if (!isCount(back) || !isCount(forward)) return null
  return { source: PREVIEW_BRIDGE_SOURCE, type: "nav", path, title, back, forward }
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}
