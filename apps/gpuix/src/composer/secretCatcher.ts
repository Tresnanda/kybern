// The pasted-secret catcher: finds an API key or token in text that was just inserted into the composer.
//
// Prefix rules decide (a known prefix at a word boundary with the length real keys have); entropy is only a second
// signal, for a long value right after `KEY=`, `TOKEN:` and the like. Nothing here keeps or logs a value: matches are
// returned to the caller, which holds them in memory until the person chooses.
//
// Not flagged on purpose: git SHAs, UUIDs, paths, plain URLs, test keys (`sk_test_`, `pk_`) and documentation
// placeholders (`user:password@host`).

export interface SecretMatch {
  /** The range in the text to replace with the chip. Covers `NAME=` and quotes when the key was pasted as an assignment. */
  start: number
  end: number
  /** The secret itself (without a `NAME=` prefix or quotes). */
  value: string
  /** "Anthropic", "GitHub", … for the strip's second line; "a key" when only entropy decided. */
  provider: string
  /** The variable name to store it under, valid for the daemon (`^[A-Z_][A-Z0-9_]*$`). */
  name: string
}

/** Fewer inserted characters than this are never a pasted secret. */
export const MIN_INSERT = 16

interface Rule { provider: string; name: string; pattern: RegExp }

// Lookbehind keeps a rule from matching inside a longer word, and `-`/`_` count as word characters in keys.
const B = String.raw`(?<![A-Za-z0-9_-])`
// More specific prefixes first: an Anthropic key also starts with `sk-`.
const RULES: Rule[] = [
  { provider: 'Anthropic', name: 'ANTHROPIC_API_KEY', pattern: new RegExp(String.raw`${B}sk-ant-[A-Za-z0-9_-]{80,}`) },
  { provider: 'OpenAI', name: 'OPENAI_API_KEY', pattern: new RegExp(String.raw`${B}sk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{40,}`) },
  { provider: 'GitHub', name: 'GITHUB_TOKEN', pattern: new RegExp(String.raw`${B}gh[pousr]_[A-Za-z0-9]{36,}`) },
  { provider: 'GitHub', name: 'GITHUB_TOKEN', pattern: new RegExp(String.raw`${B}github_pat_[A-Za-z0-9_]{60,}`) },
  { provider: 'AWS', name: 'AWS_ACCESS_KEY_ID', pattern: new RegExp(String.raw`${B}(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])`) },
  { provider: 'Slack', name: 'SLACK_BOT_TOKEN', pattern: new RegExp(String.raw`${B}xox[abposr]-[A-Za-z0-9-]{10,}`) },
  { provider: 'GitLab', name: 'GITLAB_TOKEN', pattern: new RegExp(String.raw`${B}glpat-[A-Za-z0-9_-]{20,}`) },
  { provider: 'Stripe', name: 'STRIPE_SECRET_KEY', pattern: new RegExp(String.raw`${B}sk_live_[A-Za-z0-9]{24,}`) },
  { provider: 'Stripe', name: 'STRIPE_RESTRICTED_KEY', pattern: new RegExp(String.raw`${B}rk_live_[A-Za-z0-9]{24,}`) },
  { provider: 'Google', name: 'GOOGLE_API_KEY', pattern: new RegExp(String.raw`${B}AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])`) },
]

/** A PEM private key block, through its END line (or to the end of the text when the paste stops short). */
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/
const JWT = new RegExp(String.raw`${B}eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}`)
/** `scheme://user:password@host`: the whole URL is stored, because the URL is the value people need. */
const URL_CREDENTIALS = /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s@/]+)@[^\s]+/i
/** `NAME_KEY=value`, `export API_TOKEN: "value"`, `password = value`. */
const ASSIGNMENT = /(?<![A-Za-z0-9_])(?:export\s+)?([A-Za-z][A-Za-z0-9_]*?(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?))\s*[=:]\s*(["']?)([^\s"']{32,})\2/i
/** Passwords in a documentation example are not secrets. */
const PLACEHOLDER_PASSWORD = /^(?:password|passwd|pass|secret|changeme|change-me|example|x{3,}|\*+|<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\}|your[-_ ]?\w*|redacted|user|test)$/i
/** A left-hand side that says nothing about the service (`key=…`), so the prefix's own name is better. */
const GENERIC_NAME = /^(?:API_?)?(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)$/

const TEST_KEY = /^(?:sk_test_|pk_test_|pk_live_|rk_test_|sk-test)/i
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Shannon entropy in bits per character. */
export function entropy(text: string): number {
  if (!text) return 0
  const counts = new Map<string, number>()
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1)
  let bits = 0
  for (const count of counts.values()) { const p = count / text.length; bits -= p * Math.log2(p) }
  return bits
}

/** A long value that looks random: hex above 3 bits/char, anything else above 4. Paths, URLs, SHAs and UUIDs never are. */
export function looksRandom(value: string): boolean {
  if (SHA.test(value) || UUID.test(value) || TEST_KEY.test(value)) return false
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^[~.\\]/.test(value)) return false
  if (value.includes('/') && !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false // a path
  const hex = /^[0-9a-f]+$/i.test(value)
  return entropy(value) >= (hex ? 3 : 4)
}

/** A valid variable name from anything name-like: `apiKey` → `API_KEY`, `my-token` → `MY_TOKEN`. Null when nothing is left. */
export function toEnvName(raw: string): string | null {
  const name = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase()
  if (!name || name.length > 128) return null
  return /^[0-9]/.test(name) ? `_${name}` : name
}

/** The `NAME=` (or `export NAME: "`) right before `at`, with where it starts; null when the value stands alone. */
function assignmentBefore(text: string, at: number): { name: string | null; start: number } | null {
  const lead = text.slice(Math.max(0, at - 200), at)
  const match = /(?:^|[\s;,])((?:export\s+)?([A-Za-z][A-Za-z0-9_.-]*)\s*([=:])\s*["']?)$/.exec(lead)
  if (!match) return null
  // "here it is: sk-…" is prose, not an assignment: the left side has to look like a variable name.
  const raw = match[2]!
  if (!(/[_.-]/.test(raw) || /key|token|secret|passw|credential|auth|api/i.test(raw) || (match[3] === '=' && /^[A-Z0-9]{3,}$/.test(raw)))) return null
  const name = toEnvName(match[2]!)
  return { name: name && !GENERIC_NAME.test(name) ? name : null, start: at - match[1]!.length }
}

/** The first secret in `text` whose value overlaps the character range `[from, to)` (the inserted run), or null. */
export function findSecret(text: string, from = 0, to = text.length): SecretMatch | null {
  const found: SecretMatch[] = []
  const add = (index: number, value: string, provider: string, name: string, assignment: { name: string | null; start: number } | null = assignmentBefore(text, index)) => {
    if (index + value.length <= from || index >= to) return
    const start = assignment?.start ?? index
    let end = index + value.length
    // The quotes around an assigned value go with it.
    const quote = text[index - 1]
    if (assignment && (quote === '"' || quote === "'") && text[end] === quote) end++
    found.push({ start, end, value, provider, name: assignment?.name ?? name })
  }

  for (const rule of RULES) {
    const match = rule.pattern.exec(text)
    if (match && !TEST_KEY.test(match[0])) add(match.index, match[0], rule.provider, rule.name)
  }
  const pem = PRIVATE_KEY.exec(text)
  if (pem) add(pem.index, pem[0].trimEnd(), 'a private key', 'PRIVATE_KEY', null)
  const jwt = JWT.exec(text)
  if (jwt && jwt[0].length >= 100) add(jwt.index, jwt[0], 'a JWT', 'JWT')
  const url = URL_CREDENTIALS.exec(text)
  if (url && !PLACEHOLDER_PASSWORD.test(safeDecode(url[1]!))) add(url.index, url[0], 'a service URL', /^(?:postgres|postgresql|mysql|mongodb|redis|amqp)/i.test(url[0]) ? 'DATABASE_URL' : 'SERVICE_URL')
  const assignment = ASSIGNMENT.exec(text)
  if (assignment && looksRandom(assignment[3]!)) {
    const value = assignment[3]!, valueAt = assignment.index + assignment[0].length - assignment[2]!.length - value.length
    const name = toEnvName(assignment[1]!) ?? 'API_KEY'
    add(valueAt, value, 'a key', name, { name, start: assignment.index })
  }

  if (!found.length) return null
  // The earliest wins; on a tie the longer match (the assignment over its bare value).
  return found.sort((a, b) => a.start - b.start || b.end - a.end)[0]!
}

const safeDecode = (value: string) => { try { return decodeURIComponent(value) } catch { return value } }

/**
 * What `next` inserted compared to `previous`: the common prefix and suffix are kept, the rest is the insert.
 * A replacement counts (selecting text and pasting a key over it, even over longer text); `null` when nothing new is there (a deletion, or no change).
 */
export function insertedRange(previous: string, next: string): { start: number; end: number } | null {
  let start = 0
  const max = Math.min(previous.length, next.length)
  while (start < max && previous[start] === next[start]) start++
  let tail = 0
  while (tail < max - start && previous[previous.length - 1 - tail] === next[next.length - 1 - tail]) tail++
  const end = next.length - tail
  return end > start ? { start, end } : null
}

/** A secret inserted by the edit from `previous` to `next`, if any. Small edits (typing, short pastes) are never scanned. */
export function scanInsert(previous: string, next: string): SecretMatch | null {
  const range = insertedRange(previous, next)
  if (!range || range.end - range.start < MIN_INSERT) return null
  return findSecret(next, range.start, range.end)
}
