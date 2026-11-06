// "Report a problem": the text of a prefilled GitHub issue for a failure, with everything personal taken out first. The repository is
// public, so nothing that names the person, their computer, their folders or their accounts may reach the issue. The app shows this text
// in a review sheet, lets the person edit it, and opens the issue only when they confirm.
//
// `redactForReport` is the one place that decides what is removed; `buildProblemReport` assembles the issue from a `ProblemView`;
// `reportIssueUrl` makes the address (kept short enough for GitHub to accept).
import type { ProblemView } from "./problems.ts"

export const REPORT_REPO_URL = "https://github.com/Tresnanda/kybern"

/** What is known about this computer and this build; each value is redacted like the rest. */
export interface ReportEnvironment {
  /** The desktop or mobile app's version. */
  app?: string
  /** The daemon's version, when connected to one. */
  daemon?: string
  /** "Windows", "macOS", "Linux", "Android" or "iOS", with a version if known. */
  os?: string
  /** The machine's CPU architecture: "x64", "arm64". */
  arch?: string
}

export interface ReportNames {
  /** The signed-in user name of the OS account. */
  users?: readonly string[]
  /** Host names of this computer and the names people gave other machines. */
  machines?: readonly string[]
}

export interface ProblemReport {
  title: string
  body: string
}

const REDACTED = {
  path: "<path>",
  email: "<email>",
  secret: "<secret>",
  user: "<user>",
  machine: "<machine>",
  address: "<address>",
  link: "<pairing link>",
} as const

/** Caps what a long technical text adds to the issue: the start has the cause, the end the last frames. */
const DETAIL_LIMIT = 1800
/** GitHub refuses an address much beyond this. */
const URL_LIMIT = 7000

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Names to find in free text: not empty and long enough that replacing them cannot mangle ordinary words. */
function nameList(names: readonly string[] | undefined): string[] {
  const seen = new Set<string>()
  for (const raw of names ?? []) {
    const name = raw.trim()
    if (name.length >= 3 && !/^(root|user|admin|name|home|test|this|local)$/i.test(name)) seen.add(name)
  }
  // Longest first, so "satyamas-pc" goes before "satyamas".
  return [...seen].sort((a, b) => b.length - a.length)
}

function replaceNames(text: string, names: string[], replacement: string): string {
  let out = text
  for (const name of names) out = out.replace(new RegExp(`(?<![A-Za-z0-9])${escapeRegex(name)}(?![A-Za-z0-9])`, "gi"), replacement)
  return out
}

/** Keys whose value is a credential in `key=value`, `key: value` and `"key": "value"` forms. */
const SECRET_KEY = String.raw`(?:[\w.-]*?(?:token|secret|passw(?:or)?d|passwd|pwd|api[_-]?key|apikey|auth(?:orization)?|credential|cookie|session|private[_-]?key|signature|bearer)[\w.-]*)`
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Credentials and secret-looking strings. */
function stripSecrets(input: string): string {
  let text = input
  // Pairing links carry the one-time code and the address.
  text = text.replace(/kybern:\/\/pair\?[^\s"'<>)]*/gi, REDACTED.link)
  // `user:password@host` in any URL.
  text = text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@"'<>]+@/gi, `$1${REDACTED.secret}@`)
  // Known token shapes.
  text = text
    .replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}/g, REDACTED.secret)
    .replace(/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g, REDACTED.secret)
    .replace(/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, REDACTED.secret)
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED.secret)
    .replace(/\bAIza[0-9A-Za-z_-]{30,}/g, REDACTED.secret)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, REDACTED.secret)
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, REDACTED.secret)
  // "Authorization: Bearer abc", "Bearer abc".
  text = text.replace(/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED.secret}`)
  // key=value, key: value, "key": "value" for credential-like keys.
  text = text.replace(new RegExp(String.raw`(["']?${SECRET_KEY}["']?\s*[:=]\s*)(["']?)(?:(?:Bearer|Basic|Token)\s+)?[^\s"',;&]+\2`, "gi"), `$1$2${REDACTED.secret}$2`)
  // A long run of letters and digits that is not a word, a path or an id: a key someone pasted.
  text = text.replace(/[A-Za-z0-9_+/=-]{32,}/g, (run) => {
    if (UUID.test(run) || run === REDACTED.secret) return run
    if (/^[A-Za-z]+$/.test(run) || /^[0-9]+$/.test(run)) return run
    if (/^[a-z]+(-[a-z]+)+$/i.test(run)) return run
    // A commit hash and a route such as repos/owner/name/pulls/1/reviews are not credentials.
    if (/^[0-9a-f]{40}$/i.test(run) || run.split("/").length >= 3) return run
    return REDACTED.secret
  })
  return text
}

/** Absolute paths on any OS. A path is replaced whole: even a project folder's name says something about the person. */
function stripPaths(input: string): string {
  return input
    // A quoted path may have spaces in it ("Application Support"): the quotes say where it ends.
    .replace(/(["'`])((?:\\\\\?\\)?(?:(?<![A-Za-z0-9])[A-Za-z]:[\\/]|\\\\|~[\\/]|\/(?:Users|home|root|var|private|tmp|opt|mnt|Volumes|srv|run|media|etc|usr|snap|workspace|workspaces|app)\/)[^"'`\r\n]*)\1/g, `$1${REDACTED.path}$1`)
    // Windows drive and UNC paths, including the `\\?\` prefix; stops at a quote, a bracket or the end of a line.
    .replace(/(?:\\\\\?\\)?(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'`<>|*?\r\n]*/g, REDACTED.path)
    .replace(/\\\\[A-Za-z0-9_.$-]+\\[^\s"'`<>|*?\r\n]*/g, REDACTED.path)
    // `~` and the Unix places a person's files live in.
    .replace(/(^|[\s"'`(=:[,])~[\\/][^\s"'`)<>\r\n]*/g, `$1${REDACTED.path}`)
    .replace(/(^|[\s"'`(=:[,])\/(?:Users|home|root|var|private|tmp|opt|mnt|Volumes|srv|run|media|etc|usr|snap|workspace|workspaces|app)\/[^\s"'`)<>\r\n]*/g, `$1${REDACTED.path}`)
}

/** Network addresses that identify a computer: IP addresses and the host names a LAN or tailnet gives it. */
function stripAddresses(input: string): string {
  return input
    .replace(/\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b(?::\d+)?/g, (ip) => (/^(?:127\.0\.0\.1|0\.0\.0\.0)\b/.test(ip) ? ip : REDACTED.address))
    .replace(/\b(?:[a-f0-9]{1,4}:){3,7}[a-f0-9]{1,4}\b/gi, (v6) => (v6 === "::1" ? v6 : REDACTED.address))
    .replace(/\b[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:ts\.net|local|lan|internal|home\.arpa|localdomain)(?![\w-]|\.\w)/gi, REDACTED.address)
}

/**
 * `text` with local paths (home folders and any other absolute path), the person's name and computer names, e-mail addresses, credentials,
 * pairing links and network addresses replaced by a `<…>` marker. Always safe to call twice.
 */
export function redactForReport(text: string, names: ReportNames = {}): string {
  let out = stripSecrets(text)
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, REDACTED.email)
  out = stripPaths(out)
  // Names before addresses: a computer's name often ends in ".local".
  out = replaceNames(out, nameList(names.users), REDACTED.user)
  out = replaceNames(out, nameList(names.machines), REDACTED.machine)
  out = stripAddresses(out)
  return out
}

/** A fence long enough that `text` cannot end the code block early. */
function fenceFor(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))
  return "`".repeat(Math.max(3, longest + 1))
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text
  const head = Math.ceil(limit * 0.7)
  return `${text.slice(0, head).trimEnd()}\n[…]\n${text.slice(text.length - (limit - head)).trimStart()}`
}

/** The kind and subject as one line. A machine's name is the person's own, so it is never named. */
function subjectLine(view: Pick<ProblemView, "kind" | "subject">, names: ReportNames): string {
  const subject = view.subject
  if (!subject) return view.kind
  const machineSubject = view.kind === "offline" || subject === "machine" || (names.machines ?? []).some((name) => name.toLowerCase() === subject.toLowerCase())
  return `${view.kind}: ${machineSubject ? REDACTED.machine : subject}`
}

/** The prefilled issue for `view`: a title from the headline and a body with the kind, the subject, the technical text and the environment. */
export function buildProblemReport(view: Pick<ProblemView, "kind" | "subject" | "title" | "detail">, environment: ReportEnvironment = {}, names: ReportNames = {}): ProblemReport {
  const clean = (text: string) => redactForReport(text, names)
  const title = clean(view.title).replace(/\s+/g, " ").trim().slice(0, 140)
  const detail = clip(clean(view.detail).trim(), DETAIL_LIMIT)
  const fence = fenceFor(detail)
  const software = [environment.app && `Kybern ${environment.app}`, environment.daemon && `daemon ${environment.daemon}`].filter(Boolean).join(", ")
  const system = [environment.os, environment.arch].filter(Boolean).join(" ")
  const lines = [
    "**What I was doing**",
    "",
    "",
    "**Problem**",
    `- ${clean(subjectLine(view, names))}`,
    "",
    ...(detail ? ["**Technical detail**", fence, detail, fence, ""] : []),
    "**This computer**",
    ...(software ? [`- ${clean(software)}`] : []),
    ...(system ? [`- ${clean(system)}`] : []),
  ]
  return { title, body: lines.join("\n").trimEnd() }
}

/** The address that opens GitHub's new-issue page with `report` filled in; the body is shortened to fit when it has to be. */
export function reportIssueUrl(report: ProblemReport): string {
  const make = (body: string) => `${REPORT_REPO_URL}/issues/new?title=${encodeURIComponent(report.title)}&body=${encodeURIComponent(body)}`
  let body = report.body
  let url = make(body)
  while (url.length > URL_LIMIT && body.length > 200) {
    body = `${body.slice(0, Math.floor(body.length * 0.8)).trimEnd()}\n\n[…cut to fit the address]`
    url = make(body)
  }
  return url
}
