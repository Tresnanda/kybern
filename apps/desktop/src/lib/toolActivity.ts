// Provider-agnostic presentation of native tool calls from every Kybern driver.
// Keeps the wire payload untouched while deriving a concise, tense-aware activity row.

import type { JsonValue, ToolCall } from "@/protocol"

type JsonRecord = Record<string, unknown>

export type ToolActivityKind =
  | "command"
  | "read"
  | "search"
  | "list"
  | "write"
  | "edit"
  | "fetch"
  | "delegate"
  | "plan"
  | "image"
  | "other"

export interface ToolActivityLine {
  verb: string
  detail: string
  mono: boolean
  kind: ToolActivityKind
}

const NESTED_INPUT_KEYS = [
  "raw",
  "raw_input",
  "rawInput",
  "input",
  "arguments",
  "args",
  "params",
  "item",
  "data",
  "call",
] as const
const COMMAND_TOOLS = new Set([
  "bash",
  "shell",
  "execute",
  "exec",
  "run",
  "command",
  "commandexecution",
])
const READ_TOOLS = new Set(["read", "readfile", "viewfile", "openfile"])
const WRITE_TOOLS = new Set(["write", "writefile", "createfile"])
const EDIT_TOOLS = new Set([
  "edit",
  "editfile",
  "multiedit",
  "applypatch",
  "strreplaceeditor",
  "patch",
  "filechange",
])
const SEARCH_TOOLS = new Set([
  "grep",
  "glob",
  "search",
  "ripgrep",
  "find",
  "findfiles",
])
const LIST_TOOLS = new Set(["list", "listfiles", "ls"])
const FETCH_TOOLS = new Set(["webfetch", "fetch", "urlfetch", "httpfetch"])
const WEB_SEARCH_TOOLS = new Set(["websearch", "searchweb", "webrun"])
const DELEGATE_TOOLS = new Set([
  "task",
  "agent",
  "subagent",
  "delegate",
  "spawnagent",
  "sendmessagetoagent",
  "followuptask",
  "waitagent",
  "listagents",
])
const PLAN_TOOLS = new Set(["todowrite", "todo", "plan", "updateplan"])
const IMAGE_TOOLS = new Set([
  "imageview",
  "viewimage",
  "imagegeneration",
  "generateimage",
])
const READ_COMMANDS = new Set([
  "cat",
  "nl",
  "head",
  "tail",
  "sed",
  "less",
  "more",
])
const SEARCH_COMMANDS = new Set(["rg", "grep", "ag", "ack"])

function asRecord(value: unknown): JsonRecord | null {
  if (value !== null && typeof value === "object" && !Array.isArray(value))
    return value as JsonRecord
  if (typeof value !== "string" || !value.trimStart().startsWith("{"))
    return null
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? (parsed as JsonRecord)
      : null
  } catch {
    return null
  }
}

function directString(record: JsonRecord, key: string): string | undefined {
  const value = record[key]
  if (typeof value === "string")
    return value.split("\n")[0]?.trim() || undefined
  if (Array.isArray(value) && value.every((part) => typeof part === "string"))
    return value.join(" ").trim() || undefined
  return undefined
}

/** Provider payloads differ mostly in how deeply they wrap the original tool input. */
function inputRecords(input: JsonValue): JsonRecord[] {
  const root = asRecord(input)
  if (!root) return []
  const records: JsonRecord[] = []
  const queue: { record: JsonRecord; depth: number }[] = [
    { record: root, depth: 0 },
  ]
  const seen = new Set<JsonRecord>()
  while (queue.length > 0) {
    const current = queue.shift()!
    if (seen.has(current.record)) continue
    seen.add(current.record)
    records.push(current.record)
    if (current.depth >= 4) continue
    for (const key of NESTED_INPUT_KEYS) {
      const nested = asRecord(current.record[key])
      if (nested) queue.push({ record: nested, depth: current.depth + 1 })
    }
  }
  return records
}

function inputString(
  input: JsonValue,
  keys: readonly string[]
): string | undefined {
  for (const record of inputRecords(input)) {
    for (const key of keys) {
      const value = directString(record, key)
      if (value) return value
    }
  }
  return undefined
}

function inputQuery(input: JsonValue): string | undefined {
  const direct = inputString(input, ["query", "q", "pattern"])
  if (direct) return direct
  for (const record of inputRecords(input)) {
    for (const key of ["search_query", "image_query"] as const) {
      const entries = record[key]
      if (!Array.isArray(entries)) continue
      for (const entry of entries) {
        const item = asRecord(entry)
        if (!item) continue
        const query = directString(item, "q") ?? directString(item, "query")
        if (query) return query
      }
    }
  }
  return undefined
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "")
}

function compactText(value: string, max = 120): string {
  const oneLine = value.replace(/\s+/g, " ").trim()
  return oneLine.length > max
    ? `${oneLine.slice(0, max - 1).trimEnd()}…`
    : oneLine
}

function titleCaseWords(value: string): string {
  return value
    .split(/[\s:_/-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

/** A provider namespace is useful context; its transport spelling is not. */
export function humanizeToolName(name: string): string {
  const lower = name.toLowerCase()
  if (lower === "web__run") return "Web search"
  const namespaced = name.split("__").filter(Boolean)
  const slashNamespaced = name.startsWith("mcp:")
    ? name.slice(4).split("/").filter(Boolean)
    : []
  const parts = namespaced.length > 1 ? namespaced : slashNamespaced
  if (parts.length > 1) {
    const tool = titleCaseWords(parts.at(-1)!)
    if (lower.includes("github")) return `GitHub · ${tool}`
    if (/browser|playwright|computer|cua/.test(lower))
      return `Browser · ${tool}`
    const server = titleCaseWords(parts.at(-2)!.replace(/^codex[_-]apps?$/, "apps"))
    return `${server} · ${tool}`
  }
  return titleCaseWords(name) || "Tool"
}

function leafToolName(name: string): string {
  const doubleUnderscore = name.split("__").filter(Boolean)
  if (doubleUnderscore.length > 1) return normalized(doubleUnderscore.at(-1)!)
  const segments = name.replace(/^mcp:/i, "").split(/[/:.]/).filter(Boolean)
  return normalized(segments.at(-1) ?? name)
}

function matchesTool(set: ReadonlySet<string>, tool: string, leaf: string): boolean {
  return set.has(tool) || set.has(leaf)
}

function compactPath(value: string | undefined): string {
  if (!value) return ""
  if (value === ".") return "current directory"
  if (value === "..") return "parent directory"
  const clean = value.replace(/^file:\/\//, "").replace(/[\\/]+$/, "")
  const parts = clean.split(/[\\/]/).filter(Boolean)
  if (parts.length === 0) return clean
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : parts.join("/")
}

function activityVerb(kind: ToolActivityKind, complete: boolean): string {
  switch (kind) {
    case "command":
      return complete ? "Ran" : "Running"
    case "read":
      return complete ? "Read" : "Reading"
    case "search":
      return complete ? "Searched" : "Searching"
    case "list":
      return complete ? "Listed" : "Listing"
    case "write":
      return complete ? "Wrote" : "Writing"
    case "edit":
      return complete ? "Edited" : "Editing"
    case "fetch":
      return complete ? "Fetched" : "Fetching"
    case "delegate":
      return complete ? "Delegated" : "Delegating"
    case "plan":
      return complete ? "Updated the plan" : "Updating the plan"
    case "image":
      return complete ? "Viewed" : "Viewing"
    case "other":
      return complete ? "Used" : "Using"
  }
}

function line(
  kind: ToolActivityKind,
  detail: string,
  complete: boolean,
  mono = true,
  verb = activityVerb(kind, complete)
): ToolActivityLine {
  return { verb, detail, mono, kind }
}

interface CommandAction {
  type: string
  command?: string
  name?: string
  path?: string
  query?: string
}

function commandActions(input: JsonValue): CommandAction[] {
  for (const record of inputRecords(input)) {
    const candidate = record.actions ?? record.commandActions
    if (!Array.isArray(candidate)) continue
    const actions: CommandAction[] = []
    for (const value of candidate) {
      const action = asRecord(value)
      if (!action) continue
      const type = directString(action, "type") ?? "unknown"
      actions.push({
        type,
        command: directString(action, "command"),
        name: directString(action, "name"),
        path: directString(action, "path"),
        query: directString(action, "query"),
      })
    }
    if (actions.length > 0) return actions
  }
  return []
}

function commandActionLine(
  action: CommandAction,
  complete: boolean
): ToolActivityLine | null {
  const type = normalized(action.type)
  if (type === "read" || type === "readfile") {
    const name =
      action.name && !READ_TOOLS.has(normalized(action.name))
        ? action.name
        : undefined
    return line("read", name ?? compactPath(action.path), complete)
  }
  if (type === "search" || type === "find") {
    const path = compactPath(action.path)
    const detail =
      action.query && path
        ? `for ${action.query} in ${path}`
        : action.query
          ? `for ${action.query}`
          : path
            ? `in ${path}`
            : ""
    return line("search", detail, complete)
  }
  if (type === "listfiles" || type === "list")
    return line(
      "list",
      compactPath(action.path) || action.name || "current directory",
      complete
    )
  return null
}

function stripOuterQuotes(value: string): string {
  const trimmed = value.trim()
  const first = trimmed[0]
  if ((first === '"' || first === "'") && trimmed.at(-1) === first)
    return trimmed.slice(1, -1)
  return trimmed
}

function shellSegments(value: string): string[] {
  const segments: string[] = []
  let start = 0
  let quote = ""
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i]!
    if (quote) {
      if (char === quote && value[i - 1] !== "\\") quote = ""
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    const pair = value.slice(i, i + 2)
    if (
      char === ";" ||
      char === "\n" ||
      char === "|" ||
      pair === "&&" ||
      pair === "||"
    ) {
      const segment = value.slice(start, i).trim()
      if (segment) segments.push(segment)
      i += pair === "&&" || pair === "||" ? 1 : 0
      start = i + 1
    }
  }
  const tail = value.slice(start).trim()
  if (tail) segments.push(tail)
  return segments
}

function shellTokens(value: string): string[] {
  const tokens: string[] = []
  const pattern = /"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'|([^\s]+)/g
  for (const match of value.matchAll(pattern))
    tokens.push(
      (match[1] ?? match[2] ?? match[3] ?? "").replace(/\\(["'])/g, "$1")
    )
  return tokens
}

function executable(value: string): string {
  return value.split(/[\\/]/).at(-1)?.toLowerCase() ?? ""
}

function unwrapShellCommand(value: string): string {
  let command = value.trim()
  for (let pass = 0; pass < 3; pass += 1) {
    const match =
      /^(?:[^\s]*[\\/])?(?:zsh|bash|sh|fish|pwsh|powershell)(?:\.exe)?\s+(?:-[a-z]*c|\/c)\s+([\s\S]+)$/i.exec(
        command
      )
    if (!match?.[1]) break
    command = stripOuterQuotes(match[1])
      .replace(/\\(["'])/g, "$1")
      .trim()
  }
  return command
}

function meaningfulCommandTokens(segment: string): string[] {
  const tokens = shellTokens(segment)
  while (tokens.length > 0) {
    const tool = executable(tokens[0]!)
    if (tool === "rtk" || tool === "command" || tool === "sudo") {
      tokens.shift()
      continue
    }
    if (tool === "timeout") {
      tokens.shift()
      if (tokens[0] && /^\d+(?:\.\d+)?[smhd]?$/i.test(tokens[0])) tokens.shift()
      continue
    }
    if (tool === "env") {
      tokens.shift()
      while (
        tokens[0] &&
        (tokens[0]!.startsWith("-") ||
          /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]!))
      )
        tokens.shift()
      continue
    }
    break
  }
  return tokens
}

function positionalArgs(args: readonly string[]): string[] {
  return args.filter(
    (arg) => arg.length > 0 && !arg.startsWith("-") && arg !== "--"
  )
}

function commandLine(rawCommand: string, complete: boolean): ToolActivityLine {
  const command = unwrapShellCommand(rawCommand)
  const segments = shellSegments(command)
  const segment =
    segments.find((candidate) => {
      const tool = executable(meaningfulCommandTokens(candidate)[0] ?? "")
      return tool !== "cd" && tool !== "pushd"
    }) ?? command
  const tokens = meaningfulCommandTokens(segment)
  const tool = executable(tokens[0] ?? "")
  const args = tokens.slice(1)
  const positional = positionalArgs(args)

  if (READ_COMMANDS.has(tool))
    return line("read", compactPath(positional.at(-1)) || "a file", complete)
  if (SEARCH_COMMANDS.has(tool)) {
    const query = positional[0]
    const path = positional.length > 1 ? compactPath(positional.at(-1)) : ""
    return line(
      "search",
      query && path
        ? `for ${query} in ${path}`
        : query
          ? `for ${query}`
          : path
            ? `in ${path}`
            : "",
      complete
    )
  }
  if (tool === "find" || tool === "fd") {
    const nameAt = args.findIndex((arg) => arg === "-name" || arg === "-iname")
    const query =
      nameAt >= 0 ? args[nameAt + 1] : tool === "fd" ? positional[0] : undefined
    const path =
      tool === "find" ? compactPath(positional[0]) : compactPath(positional[1])
    return line(
      "search",
      query && path
        ? `for ${query} in ${path}`
        : query
          ? `for ${query}`
          : path
            ? `in ${path}`
            : "",
      complete
    )
  }
  if (tool === "ls")
    return line(
      "list",
      compactPath(positional.at(-1)) || "current directory",
      complete
    )
  if (tool === "git") {
    switch (args[0]) {
      case "status":
        return line(
          "read",
          "repository status",
          complete,
          true,
          complete ? "Checked" : "Checking"
        )
      case "diff":
        return line(
          "read",
          "changes",
          complete,
          true,
          complete ? "Reviewed" : "Reviewing"
        )
      case "log":
      case "show":
        return line("read", "Git history", complete)
      default:
        break
    }
  }
  return line("command", compactText(segment || rawCommand), complete)
}

function titleLine(
  title: string | undefined,
  complete: boolean
): ToolActivityLine | null {
  if (!title) return null
  const match =
    /^(reading|read|searching|searched|listing|listed|running|ran|editing|edited|writing|wrote|fetching|fetched|delegating|delegated|viewing|viewed)\b\s*(.*)$/i.exec(
      title
    )
  if (!match) return null
  const word = match[1]!.toLowerCase()
  const kind: ToolActivityKind = word.startsWith("read")
    ? "read"
    : word.startsWith("search")
      ? "search"
      : word.startsWith("list")
        ? "list"
        : word === "running" || word === "ran"
          ? "command"
          : word.startsWith("edit")
            ? "edit"
            : word === "writing" || word === "wrote"
              ? "write"
              : word.startsWith("fetch")
                ? "fetch"
                : word.startsWith("delegat")
                  ? "delegate"
                  : "image"
  return line(
    kind,
    match[2]?.trim() ?? "",
    complete,
    kind !== "delegate" && kind !== "image"
  )
}

function changedPaths(input: JsonValue): string[] {
  for (const record of inputRecords(input)) {
    const changes = record.changes
    if (!Array.isArray(changes)) continue
    const paths = changes
      .map((change) => asRecord(change))
      .map((change) =>
        change
          ? (directString(change, "path") ??
            directString(change, "file_path") ??
            directString(change, "filePath"))
          : undefined
      )
      .filter((path): path is string => !!path)
    if (paths.length > 0) return paths.map(compactPath)
  }
  return []
}

/** Provider-agnostic, tense-aware activity for a tool call. */
export function toolLine(call: ToolCall, complete = true): ToolActivityLine {
  const name = call.name
  const tool = normalized(name)
  const leaf = leafToolName(name)
  const namespaced = name.includes("__") || name.startsWith("mcp:")
  const readableName = namespaced ? humanizeToolName(name) : ""
  const input = call.input

  if (!WEB_SEARCH_TOOLS.has(tool) && (matchesTool(COMMAND_TOOLS, tool, leaf) || leaf === "execcommand")) {
    const actions = commandActions(input)
    for (const action of actions) {
      const activity = commandActionLine(action, complete)
      if (activity) return activity
    }
    const actionCommand = actions.find((action) => action.command)?.command
    const command = actionCommand ?? inputString(input, ["command", "cmd"])
    if (command) return commandLine(command, complete)
    const title = inputString(input, ["title"])
    const titled = titleLine(title, complete)
    if (titled) return titled
    const target = title
      ?.replace(/^(?:run|execute|command|terminal)\b\s*:?[\s-]*/i, "")
      .trim()
    return line(
      "command",
      target && normalized(target) !== "terminal" ? target : "",
      complete
    )
  }
  if (matchesTool(READ_TOOLS, tool, leaf) || /^(?:read|getfile|viewfile)/.test(leaf)) {
    const path = inputString(input, ["file_path", "filePath", "path"])
    const title = titleLine(inputString(input, ["title"]), complete)
    return line("read", compactPath(path) || title?.detail || readableName, complete)
  }
  if (
    matchesTool(WRITE_TOOLS, tool, leaf) ||
    (/^(?:write|createfile)/.test(leaf) && !!inputString(input, ["file_path", "filePath", "path"]))
  ) {
    return line(
      "write",
      compactPath(inputString(input, ["file_path", "filePath", "path"])) || readableName,
      complete
    )
  }
  if (matchesTool(EDIT_TOOLS, tool, leaf) || /^(?:edit|updatefile|applypatch)/.test(leaf)) {
    const paths = changedPaths(input)
    const detail =
      paths.length > 0
        ? paths.join(", ")
        : compactPath(inputString(input, ["file_path", "filePath", "path"])) || readableName
    return line("edit", detail, complete)
  }
  if (matchesTool(SEARCH_TOOLS, tool, leaf) || /^(?:search|find)/.test(leaf)) {
    const query = inputString(input, ["pattern", "query"])
    const path = compactPath(inputString(input, ["path", "directory", "cwd"]))
    const context = name.toLowerCase().includes("github") ? "GitHub" : ""
    return line(
      "search",
      query && context
        ? `${context} for ${query}`
        : query && path
        ? `for ${query} in ${path}`
        : query
          ? `for ${query}`
          : path
            ? `in ${path}`
            : readableName,
      complete
    )
  }
  if (matchesTool(LIST_TOOLS, tool, leaf) || leaf.startsWith("list"))
    return line(
      "list",
      compactPath(inputString(input, ["path", "directory", "cwd"])) ||
        readableName ||
        "current directory",
      complete
    )
  if (WEB_SEARCH_TOOLS.has(tool)) {
    const query = inputQuery(input)
    return line(
      "search",
      query ? `the web for ${query}` : "the web",
      complete,
      false
    )
  }
  if (matchesTool(FETCH_TOOLS, tool, leaf))
    return line(
      "fetch",
      inputString(input, ["url", "uri", "query"]) ?? "",
      complete,
      false
    )
  if (matchesTool(DELEGATE_TOOLS, tool, leaf))
    return line(
      "delegate",
      inputString(input, ["description", "prompt", "title"]) ?? "",
      complete,
      false
    )
  if (matchesTool(PLAN_TOOLS, tool, leaf)) return line("plan", "", complete, false)
  if (matchesTool(IMAGE_TOOLS, tool, leaf) || leaf === "imagegen")
    return line(
      "image",
      inputString(input, ["path", "file_path", "filePath", "title"]) ??
        "an image",
      complete,
      false
    )

  const titled = titleLine(inputString(input, ["title"]), complete)
  if (titled) return titled
  const command = inputString(input, ["command", "cmd"])
  if (command) return commandLine(command, complete)
  const detail =
    inputString(input, ["title", "query", "path", "file_path", "filePath"]) ??
    ""
  const label = humanizeToolName(name)
  return line("other", namespaced && detail ? `${label} — ${compactText(detail)}` : detail || label, complete, !namespaced)
}

export type ToolVisualKind =
  | ToolActivityKind
  | "github"
  | "web"
  | "mcp"
  | "skill"

/** Pick a recognizable 16px glyph before falling back to the activity kind. */
export function toolVisualKind(
  call: ToolCall,
  activity: ToolActivityLine = toolLine(call)
): ToolVisualKind {
  const name = call.name.toLowerCase()
  const tool = normalized(call.name)
  const actions = commandActions(call.input)
  const rawCommand =
    actions.find((action) => action.command)?.command ??
    inputString(call.input, ["command", "cmd"])
  if (name.includes("github") || isGitCommand(rawCommand)) return "github"
  if (/browser|playwright|computer|cua[_:]/.test(name)) return "web"
  if (name === "web__run" || WEB_SEARCH_TOOLS.has(tool) || activity.kind === "fetch")
    return "web"
  if (name.startsWith("mcp__") || name.startsWith("mcp:")) return "mcp"
  const leaf = leafToolName(call.name)
  if ([tool, leaf].some((value) => value === "skill" || value === "useskill" || value === "loadskill"))
    return "skill"
  return activity.kind
}

function isGitCommand(command: string | undefined): boolean {
  if (!command) return false
  const unwrapped = unwrapShellCommand(command)
  for (const segment of shellSegments(unwrapped)) {
    const tool = executable(meaningfulCommandTokens(segment)[0] ?? "")
    if (tool === "git" || tool === "gh") return true
    if (tool !== "cd" && tool !== "pushd") return false
  }
  return false
}

export interface ToolSummaryItem {
  call: ToolCall
  complete: boolean
  isError: boolean
}

export interface ToolCallSummary {
  label: string
  visual: ToolVisualKind
  entryCount: number
}

type SummaryCategory = "command" | "edit" | "read" | "search" | "agent" | "tool"

const SUMMARY_ORDER: readonly SummaryCategory[] = [
  "command",
  "edit",
  "read",
  "search",
  "agent",
  "tool",
]

/** Summarize a settled, contiguous tool run using distinct file counts. */
export function summarizeToolCalls(
  items: readonly ToolSummaryItem[]
): ToolCallSummary | null {
  if (
    items.length < 2 ||
    items.some((item) => !item.complete || item.isError)
  )
    return null

  const counts = new Map<SummaryCategory, number>()
  const fileKeys = new Map<SummaryCategory, Set<string>>()
  for (const item of items) {
    const activity = toolLine(item.call, true)
    const category = summaryCategory(activity.kind)
    if (category === "read" || category === "edit") {
      const keys = summaryFileKeys(item.call, activity)
      if (keys.length > 0) {
        const seen = fileKeys.get(category) ?? new Set<string>()
        keys.forEach((key) => seen.add(key))
        fileKeys.set(category, seen)
        continue
      }
    }
    counts.set(category, (counts.get(category) ?? 0) + 1)
  }
  for (const [category, paths] of fileKeys)
    counts.set(category, (counts.get(category) ?? 0) + paths.size)

  const phrases = SUMMARY_ORDER.flatMap((category) => {
    const count = counts.get(category) ?? 0
    return count > 0 ? [summaryPhrase(category, count)] : []
  })
  return {
    label: joinSummaryPhrases(phrases),
    visual: toolVisualKind(items[0]!.call),
    entryCount: items.length,
  }
}

function summaryCategory(kind: ToolActivityKind): SummaryCategory {
  switch (kind) {
    case "command":
      return "command"
    case "edit":
    case "write":
      return "edit"
    case "read":
      return "read"
    case "search":
    case "list":
    case "fetch":
      return "search"
    case "delegate":
      return "agent"
    default:
      return "tool"
  }
}

function summaryFileKeys(
  call: ToolCall,
  activity: ToolActivityLine
): string[] {
  const changed = changedPaths(call.input)
  if (changed.length > 0) return changed
  const direct = inputString(call.input, ["file_path", "filePath", "path"])
  if (direct) return [direct]
  const detail = activity.detail.trim()
  if (!detail || detail === "a file") return []
  return detail.split(/,\s+/).filter(Boolean)
}

function summaryPhrase(category: SummaryCategory, count: number): string {
  const plural = (one: string, many = `${one}s`) => (count === 1 ? one : many)
  switch (category) {
    case "command":
      return `ran ${count} ${plural("command")}`
    case "edit":
      return `edited ${count} ${plural("file")}`
    case "read":
      return `read ${count} ${plural("file")}`
    case "search":
      return `ran ${count} ${plural("search", "searches")}`
    case "agent":
      return `ran ${count} agent ${plural("task")}`
    case "tool":
      return `used ${count} ${plural("tool")}`
  }
}

function joinSummaryPhrases(phrases: readonly string[]): string {
  if (phrases.length === 0) return "Used tools"
  const [first, ...rest] = phrases
  const capitalized = first!.charAt(0).toUpperCase() + first!.slice(1)
  if (rest.length === 0) return capitalized
  if (rest.length === 1) return `${capitalized} and ${rest[0]}`
  return `${capitalized}, ${rest.slice(0, -1).join(", ")}, and ${rest.at(-1)}`
}
