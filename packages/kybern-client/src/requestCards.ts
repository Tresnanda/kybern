// The daemon's summoned request cards (sign-in, password prompt, macOS permission, a question with a deadline), as both
// clients read them: the card's input, its copy, the countdown and the one line a settled card leaves in the transcript.
// Contract: the doc comments on `LOGIN_REQUEST_TOOL`, `PROMPT_REQUEST_TOOL`, `PERMISSION_REQUEST_TOOL`, `QuestionDeadline` and
// `RequestProgress` in `types.ts`. A secret never passes through here; records show the command, never a value.
import {
  LOGIN_REQUEST_TOOL,
  PERMISSION_REQUEST_TOOL,
  PROMPT_REQUEST_TOOL,
  type ApprovalDecision,
  type ApprovalRequest,
  type LoginRequestInput,
  type PermissionRequestInput,
  type PromptRequestInput,
  type QuestionDeadline,
  type RequestProgress,
} from "./types.ts"

type Approvalish = Pick<ApprovalRequest, "tool_name" | "input">

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
const text = (value: unknown): string => (typeof value === "string" ? value : "")
const maybe = (value: unknown): string | null => (typeof value === "string" && value ? value : null)

/** Why the daemon closes a card nobody answered (as for secrets). */
export const TURN_ENDED = "turn ended"
export const TIMED_OUT = "timed out"

// ---- inputs ----

export function loginRequestInput(approval: Approvalish): LoginRequestInput | null {
  if (approval.tool_name !== LOGIN_REQUEST_TOOL) return null
  const input = record(approval.input)
  const cli = text(input?.cli)
  if (!input || !cli) return null
  const methods = Array.isArray(input.methods) ? input.methods.filter((m): m is string => m === "browser" || m === "terminal") : []
  return {
    cli,
    service: text(input.service) || cli,
    reason: text(input.reason),
    account: text(input.account),
    access: maybe(input.access),
    signs_in: text(input.signs_in),
    command: text(input.command),
    methods: methods.length ? methods : ["browser", "terminal"],
    custom: input.custom === true,
  }
}

export function promptRequestInput(approval: Approvalish): PromptRequestInput | null {
  if (approval.tool_name !== PROMPT_REQUEST_TOOL) return null
  const input = record(approval.input)
  if (!input) return null
  const attempt = typeof input.attempt === "number" && input.attempt >= 1 ? Math.floor(input.attempt) : 1
  return {
    purpose: text(input.purpose) || "other",
    prompt: text(input.prompt),
    secret: input.secret !== false,
    confirm: input.confirm === true,
    command: maybe(input.command),
    harness: text(input.harness) || "The agent",
    host: maybe(input.host),
    key_type: maybe(input.key_type),
    fingerprint: maybe(input.fingerprint),
    attempt,
    wait_seconds: typeof input.wait_seconds === "number" && input.wait_seconds > 0 ? input.wait_seconds : 300,
  }
}

export function permissionRequestInput(approval: Approvalish): PermissionRequestInput | null {
  if (approval.tool_name !== PERMISSION_REQUEST_TOOL) return null
  const input = record(approval.input)
  const pane = text(input?.pane)
  if (!input || !pane) return null
  return {
    pane,
    app: text(input.app) || "This app",
    bundle_id: maybe(input.bundle_id),
    app_path: maybe(input.app_path),
    reason: text(input.reason),
    pane_label: text(input.pane_label) || `Privacy & Security › ${permissionPane(pane).name}`,
    url: text(input.url),
    needs_app_added: input.needs_app_added === true,
    relaunch: input.relaunch === true,
    detects: input.detects !== false,
  }
}

/** The deadline of a daemon-owned question (`kybern_ask_user`); null for a harness's own `AskUserQuestion` and every approval. */
export function questionDeadline(approval: Approvalish): QuestionDeadline | null {
  if (approval.tool_name !== "AskUserQuestion") return null
  const deadline = record(record(approval.input)?.deadline)
  const endsAt = text(deadline?.ends_at)
  if (!deadline || !endsAt || Number.isNaN(Date.parse(endsAt))) return null
  const defaults = record(deadline.defaults) ?? {}
  return {
    defaults: Object.fromEntries(Object.entries(defaults).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    seconds: typeof deadline.seconds === "number" && deadline.seconds > 0 ? deadline.seconds : Math.max(1, (Date.parse(endsAt) - Date.parse(text(deadline.started_at) || endsAt)) / 1000),
    started_at: text(deadline.started_at) || endsAt,
    ends_at: endsAt,
  }
}

/** Cards whose own form replaces the composer input (the password prompt, and the sign-in card while it asks for a pasted code). */
export const isPromptRequest = (approval: Approvalish) => approval.tool_name === PROMPT_REQUEST_TOOL

// ---- copy ----

export interface PermissionPane {
  /** What the app may do, after "Let X …": "use the camera". */
  verb: string
  /** The pane's name in System Settings. */
  name: string
}

const PANES: Record<string, PermissionPane> = {
  camera: { verb: "use the camera", name: "Camera" },
  microphone: { verb: "use the microphone", name: "Microphone" },
  screen_recording: { verb: "record the screen", name: "Screen Recording" },
  accessibility: { verb: "control your Mac", name: "Accessibility" },
  local_network: { verb: "find devices on your network", name: "Local Network" },
  full_disk_access: { verb: "read all your files", name: "Full Disk Access" },
  notifications: { verb: "send notifications", name: "Notifications" },
  location: { verb: "use your location", name: "Location Services" },
}

export function permissionPane(pane: string): PermissionPane {
  return PANES[pane] ?? { verb: `use ${pane.replace(/_/g, " ")}`, name: pane.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) }
}

export const permissionTitle = (input: Pick<PermissionRequestInput, "app" | "pane">) => `Let ${input.app} ${permissionPane(input.pane).verb}`
export const permissionGrantedTitle = (input: Pick<PermissionRequestInput, "app" | "pane">) => `${input.app} can ${permissionPane(input.pane).verb}`
export const permissionStillOffTitle = (input: Pick<PermissionRequestInput, "app" | "pane">) => `${permissionPane(input.pane).name} is still off for ${input.app}`

/** What to click in System Settings, and what happens after. */
export function permissionStillOffMeta(input: Pick<PermissionRequestInput, "app" | "pane_label" | "needs_app_added" | "relaunch">): string {
  const where = input.needs_app_added
    ? `In ${input.pane_label}, add ${input.app} with + or by dragging it into the list, then turn it on.`
    : `In ${input.pane_label}, turn on ${input.app}.`
  return input.relaunch ? `${where} macOS applies it after ${input.app} restarts.` : where
}

export const permissionWaitingLine = (input: Pick<PermissionRequestInput, "app" | "pane">) => `Waiting for ${permissionPane(input.pane).name} to be turned on for ${input.app}…`

export type PasswordPurpose = "sudo" | "ssh_passphrase" | "ssh_host_key" | "git_username" | "git_password" | "other"

export function passwordPurpose(input: Pick<PromptRequestInput, "purpose" | "confirm">): PasswordPurpose {
  if (input.confirm) return "ssh_host_key"
  return (["sudo", "ssh_passphrase", "ssh_host_key", "git_username", "git_password"] as const).find((p) => p === input.purpose) ?? "other"
}

export interface PasswordCopy {
  glyph: "lock" | "key" | "shield"
  title: string
  /** The field's label above it (git), or null for a field with a placeholder only. */
  label: string | null
  placeholder: string
  /** The word the records and the error use: "password", "passphrase", "username", "answer". */
  noun: string
  hint: string
}

export function passwordCopy(input: Pick<PromptRequestInput, "purpose" | "confirm" | "host">): PasswordCopy {
  const host = input.host
  switch (passwordPurpose(input)) {
    case "sudo": return { glyph: "lock", title: "Enter your Mac password for sudo", label: null, placeholder: "Password", noun: "password", hint: "Cancel makes the command fail." }
    case "ssh_passphrase": return { glyph: "key", title: "Enter the passphrase for your SSH key", label: null, placeholder: "Passphrase", noun: "passphrase", hint: "Cancel makes the command fail." }
    case "ssh_host_key": return { glyph: "shield", title: "Trust this server?", label: null, placeholder: "", noun: "host key", hint: "" }
    case "git_username": return { glyph: "lock", title: host ? `Sign in to ${host}` : "Sign in to the git server", label: "Username", placeholder: "Username", noun: "username", hint: "For GitHub, Kybern offers the sign-in card instead." }
    case "git_password": return { glyph: "lock", title: host ? `Sign in to ${host}` : "Sign in to the git server", label: "Password or access token", placeholder: "Password or token", noun: "password", hint: "For GitHub, Kybern offers the sign-in card instead." }
    case "other": return { glyph: "lock", title: "Answer the command's prompt", label: null, placeholder: "Answer", noun: "answer", hint: "Cancel makes the command fail." }
  }
}

/** "Claude Code asked in “Install the Postgres service”. Kybern never answers this on its own, even in Full access." */
export function passwordMeta(input: Pick<PromptRequestInput, "purpose" | "confirm" | "host" | "harness">, threadTitle: string | null): string {
  if (passwordPurpose(input) === "ssh_host_key") {
    const host = input.host ?? "this server"
    return `This Mac has never connected to ${host}. Compare the fingerprint with the one your host shows before you trust it.`
  }
  const asked = threadTitle ? `${input.harness} asked in “${threadTitle}”.` : `${input.harness} asked.`
  return `${asked} Kybern never answers this on its own, even in Full access.`
}

export const lockLine = (agent: string) => `Used once for this command, then dropped. Kybern never stores or logs it, and ${agent} never sees it.`

/** sudo's default `passwd_tries`. */
const SUDO_TRIES = 3

/** The error under the field when the same command asked again: the previous answer was wrong. */
export function wrongAnswerError(input: Pick<PromptRequestInput, "purpose" | "confirm" | "attempt">): string | null {
  if (input.attempt < 2) return null
  if (passwordPurpose(input) !== "sudo") return "That didn't work. Try again."
  const left = SUDO_TRIES + 1 - input.attempt
  if (left <= 0) return "That password didn't work. Check it and try again."
  return `That password didn't work. sudo allows ${left} more ${left === 1 ? "try" : "tries"}.`
}

export const loginTitle = (input: Pick<LoginRequestInput, "service">) => `Sign in to ${input.service} to continue`
export const loginDoneTitle = (service: string, account?: string | null) => (account ? `Signed in to ${service} as ${account}` : `Signed in to ${service}`)

/** The status line while Kybern waits for the sign-in to finish. */
export function loginWaitingLine(progress: Pick<RequestProgress, "phase" | "method">): string {
  if (progress.phase === "verifying") return "Checking the sign-in…"
  return progress.method === "terminal" ? "Waiting for you to sign in in the terminal…" : "Waiting for you to finish in the browser…"
}

/** The host and path of a device page, as the caption shows it (`github.com/login/device`). */
export function shortUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`
  } catch {
    return url
  }
}

// ---- countdown ----

/** `m:ss` under an hour, `h:mm:ss` above. Rounds up, so the label reads 0:00 only when time is up. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, "0")
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`
}

export interface DeadlineState {
  phase: "running" | "paused" | "held"
  /** Time left, in ms (0 once it has passed). */
  remainingMs: number
  /** Share of the wait that is left, 1 → 0 (the ring). */
  fraction: number
}

/** Where a question's countdown stands: the daemon's progress wins; before the first progress the input's own deadline runs. */
export function deadlineState(deadline: QuestionDeadline, progress: Pick<RequestProgress, "phase" | "ends_at" | "remaining_ms"> | null | undefined, now: number): DeadlineState {
  const total = Math.max(1, deadline.seconds * 1000)
  if (progress?.phase === "held") return { phase: "held", remainingMs: 0, fraction: 0 }
  if (progress?.phase === "paused" && typeof progress.remaining_ms === "number") {
    const remainingMs = Math.max(0, progress.remaining_ms)
    return { phase: "paused", remainingMs, fraction: Math.min(1, remainingMs / total) }
  }
  const ends = Date.parse(progress?.ends_at || deadline.ends_at)
  const remainingMs = Math.max(0, (Number.isNaN(ends) ? 0 : ends) - now)
  return { phase: "running", remainingMs, fraction: Math.min(1, remainingMs / total) }
}

/** The option a question falls back to, by its index, or -1. */
export function defaultOption(deadline: QuestionDeadline | null, question: { title: string; options: { label: string }[] }): number {
  const label = deadline?.defaults[question.title]
  return label === undefined ? -1 : question.options.findIndex((option) => option.label === label)
}

/** The follow-up "Change answer" queues. */
export function changeAnswerMessage(question: string, chose: string, rather: string): string {
  return `I'd rather have “${rather}” for “${question}” instead of “${chose}”.`
}

// ---- records ----

export type RecordPart = { text: string; strong?: boolean; code?: boolean }
export type RecordGlyph = "lock" | "key" | "shield" | "cross" | "clock" | "service" | "app" | "check" | "question"
export type RecordTone = "done" | "declined" | "pending" | "ended"

export interface RequestRecord {
  glyph: RecordGlyph
  parts: RecordPart[]
  /** Quiet trailing text after a " · ". */
  detail?: string
  tone: RecordTone
}

/** The `auto` mark on a question the daemon answered itself when its deadline ran out. */
export interface AutoAnswer {
  at: string
  waitedSeconds: number
  answers: Record<string, string>
}

export function autoAnswer(decision: ApprovalDecision | null): AutoAnswer | null {
  if (decision?.decision !== "submit") return null
  const response = record(decision.response)
  const auto = record(response?.auto)
  if (!response || !auto) return null
  const answers = Object.fromEntries(Object.entries(record(response.answers) ?? {}).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v)]))
  return { at: text(auto.at), waitedSeconds: typeof auto.waited_seconds === "number" ? auto.waited_seconds : 0, answers }
}

/** "02:00" in the reader's locale (24 h or 12 h). */
export function clockTime(iso: string, locale?: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ""
  return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(date)
}

/** "10 min", "45 s", "1 h 30 min". */
export function waitText(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m ? `${h} h ${m} min` : `${h} h`
}

const endedReason = (decision: ApprovalDecision | null) => (decision?.decision === "deny" ? decision.reason ?? null : null)

function loginRecord(input: LoginRequestInput, decision: ApprovalDecision | null, live: boolean): RequestRecord {
  const service: RecordPart = { text: input.service, strong: true }
  if (decision?.decision === "submit") {
    const response = record(decision.response)
    const account = maybe(response?.account)
    const already = response?.status === "already_signed_in"
    const parts: RecordPart[] = [{ text: already ? "Already signed in to " : "Signed in to " }, service, ...(account ? [{ text: " as " }, { text: account, strong: true }] : [])]
    return { glyph: "service", parts, detail: already ? undefined : [input.cli, input.access].filter(Boolean).join(", "), tone: "done" }
  }
  const reason = endedReason(decision)
  if (decision?.decision === "deny" && reason === TIMED_OUT) return { glyph: "clock", parts: [{ text: "The sign-in to " }, service, { text: " timed out." }], tone: "ended" }
  if ((decision?.decision === "deny" && reason === TURN_ENDED) || (!decision && !live)) return { glyph: "cross", parts: [{ text: "The sign-in to " }, service, { text: " ended with the turn." }], tone: "ended" }
  if (decision?.decision === "deny") return { glyph: "cross", parts: [{ text: "You declined to sign in to " }, service], tone: "declined" }
  return { glyph: "service", parts: [{ text: "Waiting for you to sign in to " }, service], tone: "pending" }
}

function promptRecord(input: PromptRequestInput, decision: ApprovalDecision | null, live: boolean): RequestRecord {
  const copy = passwordCopy(input)
  const command: RecordPart[] = input.command ? [{ text: input.command, strong: true }] : [{ text: "the command" }]
  const failed: RecordPart[] = input.command ? [{ text: " " }, { text: input.command, strong: true }, { text: " failed." }] : [{ text: " The command failed." }]
  const purpose = passwordPurpose(input)
  if (purpose === "ssh_host_key") {
    const host: RecordPart = { text: input.host ?? "the server", strong: true }
    if (decision?.decision === "submit" && record(decision.response)?.confirmed === true)
      return { glyph: "shield", parts: [{ text: "Trusted " }, host, ...(input.key_type ? [{ text: ` (${input.key_type})` }] : []), { text: " and added it to " }, { text: "~/.ssh/known_hosts", code: true }], tone: "done" }
    if (decision?.decision === "submit" || (decision?.decision === "deny" && !endedReason(decision)) || endedReason(decision) === "declined")
      return { glyph: "cross", parts: [{ text: "Didn't connect to " }, host, { text: "." }, ...failed], tone: "declined" }
  }
  if (decision?.decision === "submit") {
    if (purpose === "other") return { glyph: "lock", parts: [{ text: "Answered the prompt from " }, ...command], detail: "used once", tone: "done" }
    return { glyph: "lock", parts: [{ text: `Sent your ${copy.noun} to ` }, ...command], detail: "used once", tone: "done" }
  }
  const reason = endedReason(decision)
  const prompt = purpose === "ssh_passphrase" ? "passphrase prompt" : purpose === "ssh_host_key" ? "host key question" : purpose === "other" ? "prompt" : "password prompt"
  if (decision?.decision === "deny" && reason === TIMED_OUT)
    return { glyph: "clock", parts: [{ text: `Nobody answered the ${prompt} in ${waitText(input.wait_seconds)}.` }, ...failed], tone: "ended" }
  if ((decision?.decision === "deny" && reason === TURN_ENDED) || (!decision && !live))
    return { glyph: "cross", parts: [{ text: `The ${prompt} closed when the turn ended.` }], tone: "ended" }
  if (decision?.decision === "deny") return { glyph: "cross", parts: [{ text: `You cancelled the ${prompt}.` }, ...failed], tone: "declined" }
  return { glyph: copy.glyph === "shield" ? "shield" : "lock", parts: [{ text: `Waiting for your ${copy.noun} for ` }, ...command], tone: "pending" }
}

function permissionRecord(input: PermissionRequestInput, decision: ApprovalDecision | null, live: boolean): RequestRecord {
  const app: RecordPart = { text: input.app, strong: true }
  const pane = permissionPane(input.pane)
  if (decision?.decision === "submit") {
    const status = record(decision.response)?.status
    if (status === "stopped") return { glyph: "cross", parts: [{ text: "Stopped waiting for " }, app, { text: ` to get ${pane.name}` }], tone: "ended" }
    return { glyph: "app", parts: [app, { text: ` can ${pane.verb}` }], detail: status === "user_confirmed" ? "you turned it on in System Settings" : "turned on in System Settings", tone: "done" }
  }
  const reason = endedReason(decision)
  if ((decision?.decision === "deny" && (reason === TURN_ENDED || reason === TIMED_OUT)) || (!decision && !live))
    return { glyph: "cross", parts: [{ text: "The request for " }, app, { text: ` to ${pane.verb} ended.` }], tone: "ended" }
  if (decision?.decision === "deny") return { glyph: "cross", parts: [{ text: "Declined to let " }, app, { text: ` ${pane.verb}` }], tone: "declined" }
  return { glyph: "app", parts: [{ text: "Waiting for " }, app, { text: ` to get ${pane.name}` }], tone: "pending" }
}

function autoRecord(auto: AutoAnswer, locale?: string): RequestRecord {
  const chosen = Object.values(auto.answers)
  const parts: RecordPart[] = [{ text: "Chose " }]
  chosen.forEach((answer, i) => {
    if (i > 0) parts.push({ text: i === chosen.length - 1 ? " and " : ", " })
    parts.push({ text: `“${answer}”`, strong: true })
  })
  const at = clockTime(auto.at, locale)
  parts.push({ text: at ? ` automatically at ${at}` : " automatically" })
  return { glyph: "clock", parts, detail: auto.waitedSeconds > 0 ? `no answer within ${waitText(auto.waitedSeconds)}` : undefined, tone: "done" }
}

/** The line a summoned card leaves in the transcript, or null for any other approval. `live` is false once the turn is over. */
export function requestRecord(approval: ApprovalRequest, decision: ApprovalDecision | null, live = true, locale?: string): RequestRecord | null {
  const login = loginRequestInput(approval)
  if (login) return loginRecord(login, decision, live)
  const prompt = promptRequestInput(approval)
  if (prompt) return promptRecord(prompt, decision, live)
  const permission = permissionRequestInput(approval)
  if (permission) return permissionRecord(permission, decision, live)
  const auto = approval.tool_name === "AskUserQuestion" ? autoAnswer(decision) : null
  if (auto) return autoRecord(auto, locale)
  return null
}

export const recordText = (record: RequestRecord) => `${record.parts.map((part) => part.text).join("")}${record.detail ? ` · ${record.detail}` : ""}`

// ---- settings ----

/** `settings.ask_deadlines` when the daemon has none yet. */
export const ASK_DEADLINE_DEFAULTS = { enabled: true, max_seconds: 900 } as const

/** "Longest wait an agent can set": the choices, in seconds; a value set elsewhere is listed too. */
export function askDeadlineOptions(current?: number): { value: string; label: string }[] {
  const choices = [300, 600, 900, 1800, 3600, 14400]
  const label = (s: number) => (s < 3600 ? `${s / 60} minutes` : s === 3600 ? "1 hour" : `${s / 3600} hours`)
  const list = current && !choices.includes(current) ? [...choices, current].sort((a, b) => a - b) : choices
  return list.map((s) => ({ value: String(s), label: choices.includes(s) ? label(s) : waitText(s) }))
}
