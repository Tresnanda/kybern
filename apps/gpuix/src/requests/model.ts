// What a request card says and what each of its numbered rows does (Direction B, "Option list"). One pure function builds the
// card for every approval kind so the key map, the rows on screen and the RPC the row sends can never drift apart: digits
// follow the visible order and Decline is always the last number.
import { toolLine } from '../../../../packages/kybern-client/src/toolActivity.ts'
import { basename } from '../../../desktop/src/lib/format.ts'
import { computerConsent, connectorApproval, connectorApprovalResponse, notesTasksConsent, record, string, array, type ConnectorApproval, type NotesTasksConsent } from '../../../../packages/kybern-client/src/userInput.ts'
import type { ApprovalDecision, ApprovalRequest, JsonValue } from '../../../../packages/kybern-client/src/types.ts'

/** A run of a row's label: plain words or a command in the inline code chip. */
export interface Part { text: string; code?: boolean }

export type RowAction =
  | { kind: 'decide'; decision: ApprovalDecision }
  /** Opens the note field in the row; Return sends `{ decision: 'deny', reason }`, an empty note a plain deny. */
  | { kind: 'decline' }

export interface RowSpec {
  /** Stable key, also the test id suffix (`approval-row-once`). */
  id: 'once' | 'session' | 'always' | 'decline'
  label: Part[]
  action: RowAction
}

export type CardKind = 'command' | 'read' | 'edit' | 'plan' | 'connector' | 'computer' | 'notes' | 'grant'

export interface DiffLine { kind: 'add' | 'del' | 'ctx'; text: string }
export interface DiffSpec { path: string; added: number; removed: number; lines: DiffLine[] }
export interface GrantLine { name: string; target: string; glyph: 'network' | 'folder' | 'tool' }

export type WellSpec =
  | { kind: 'command'; command: string }
  | { kind: 'diff'; diff: DiffSpec }
  | { kind: 'file'; path: string }
  | { kind: 'plan'; plan: string }
  | { kind: 'notes'; consent: NotesTasksConsent }
  | { kind: 'grants'; lines: GrantLine[] }
  | { kind: 'text'; text: string }

export interface CardModel {
  kind: CardKind
  glyph: 'terminal' | 'file' | 'pencil' | 'plan' | 'plug' | 'laptop' | 'task' | 'note' | 'shield'
  title: string
  /** The line under the title, aligned with the title text. */
  meta?: string
  /** The chip at the right of the title (the connector, "Plan mode", "Computer use", the harness). */
  chip?: { label: string; mono?: boolean }
  well: WellSpec | null
  rows: RowSpec[]
  /** The agent's name in "Decline and tell … what to do instead". */
  agent: string
}

/** The harness's name in card copy ("Decline and tell Claude …"), not the product name. */
export const AGENT_NAMES: Record<string, string> = { 'claude-code': 'Claude', codex: 'Codex', opencode: 'OpenCode', pi: 'Pi', omp: 'Pi', cursor: 'Cursor' }
export const agentName = (provider: string | undefined): string => AGENT_NAMES[provider ?? ''] ?? 'the agent'

const text = (value: string): Part => ({ text: value })
const code = (value: string): Part => ({ text: value, code: true })

// ---- session scope ----

/** Where a Claude permission suggestion is saved: only `session` ends with the session. */
const lasts = (destination: unknown) => destination === 'session'

const stripRule = (rule: string): string => rule.replace(/:\*$/, '').replace(/ \*$/, '').trim()
/** A rule that ends in a wildcard (`pnpm run:*`, `pnpm run *`) allows every command that starts with it. */
const isPrefix = (rule: string): boolean => /(:\*| \*)$/.test(rule.trim())
const clip = (value: string, max = 34): string => (value.length > max ? `${value.slice(0, max - 1)}…` : value)

/** `a`, `a and b`, `a, b and 3 more`: two names, then a count. */
export function listParts(names: string[]): Part[] {
  const unique = [...new Set(names.filter(Boolean))]
  if (unique.length <= 2) return unique.flatMap((name, i) => (i ? [text(' and '), code(clip(name))] : [code(clip(name))]))
  const more = unique.length - 2
  return [code(clip(unique[0]!)), text(', '), code(clip(unique[1]!)), text(` and ${more} more`)]
}

interface Scope { names: Part[]; session: boolean }

/** The names, then " commands" when a name is a prefix rule (`pnpm run` allows `pnpm run anything`), like Claude Code's own prompt. */
const scopeNames = (names: string[], prefix: boolean, more = false): Part[] => [...listParts(names), ...(prefix ? [text(' commands')] : []), ...(more ? [text(' and other permission changes')] : [])]

/**
 * What Claude's `updatedPermissions` (the approval's `suggestions`, all sent with "allow for this session") allows: rules, a mode
 * switch or folders. An update the card cannot name is still sent, so the label says there is more.
 */
function claudeScope(suggestions: JsonValue[]): Scope | null {
  const names: string[] = []
  let prefix = false
  let modes = 0
  let more = false
  let every = false
  let session = true
  for (const raw of suggestions) {
    const update = record(raw)
    if (!lasts(update.destination)) session = false
    if ((update.type === 'addRules' || update.type === 'replaceRules') && (update.behavior === undefined || update.behavior === 'allow')) {
      for (const rule of array(update.rules).map(record)) {
        const tool = string(rule.toolName), raw = string(rule.ruleContent), content = stripRule(raw)
        const shell = /^(bash|shell)$/i.test(tool)
        if (shell && content && isPrefix(raw)) prefix = true
        if (shell && !content) every = true
        else names.push(shell ? content : content ? `${tool}(${content})` : tool)
      }
    } else if (update.type === 'setMode' && update.mode === 'acceptEdits') modes++
    else if (update.type === 'addDirectories') names.push(...array(update.directories).map(String))
    else more = true
  }
  // A shell rule with no command allows every command: that is the scope to name, whatever else comes with it.
  if (every) return { names: [text('every command'), ...(names.length || modes || more ? [text(' and other permission changes')] : [])], session }
  if (!names.length && !modes) return more ? { names: [text('the permission changes Claude suggests')], session } : null
  return { names: names.length ? scopeNames(names, prefix, more) : [text('edits'), ...(more ? [text(' and other permission changes')] : [])], session }
}

/** OpenCode's `always` patterns (the request's suggestions) approve matching requests for the rest of the session. */
function opencodeScope(approval: ApprovalRequest): Scope {
  const raw = approval.suggestions.filter((s): s is string => typeof s === 'string')
  const names = raw.map(stripRule).filter((p) => p && p !== '*')
  const prefix = /^(bash|shell)$/i.test(approval.tool_name) && raw.some((p) => p.trim() !== '*' && isPrefix(p))
  return { names: names.length ? scopeNames(names, prefix) : [text('every '), code(approval.tool_name), text(' request')], session: true }
}

/** The label of Cursor's own "always" option for this request, or null when it offers none (Cursor would then allow once). */
function cursorAlways(approval: ApprovalRequest): Part[] | null {
  const option = array(record(approval.input).options).map(record).find((o) => /^allowalways/i.test(string(o.kind).replace(/[_\s-]/g, '')))
  if (!option) return null
  const name = string(option.name).trim()
  return [text(name ? name.charAt(0).toUpperCase() + name.slice(1) : 'Always allow this request')]
}

type Noun = 'command' | 'edit' | 'read' | 'other'

/** Codex's "accept for session" remembers this exact command, and an edit's files (later edits to them go through). */
function codexNoun(approval: ApprovalRequest, noun: Noun): string {
  if (noun === 'command') return 'this exact command'
  if (noun === 'edit') return array(record(approval.input).changes).length > 1 ? 'edits to these files' : 'edits to this file'
  return 'this exact request'
}

/** Pi's "always allow" (Kybern's extension) remembers this exact call, input and all, until the session or the mode changes. */
const piNoun = (noun: Noun) => (noun === 'command' ? 'this exact command' : noun === 'edit' ? 'this exact edit' : noun === 'read' ? 'this exact read' : 'this exact call')

/**
 * The "allow for this session" option, worded for what the harness really allows, or null when it allows nothing beyond one run:
 * Claude applies the rules in `suggestions` (an empty list changes nothing), OpenCode its `always` patterns, Codex remembers this
 * command or the edited files, Pi (through Kybern's extension, which gives the call an id) this exact call, and Cursor offers its
 * own "always" option. Pi's other permission prompts and a Cursor request without that option only approve once.
 */
export function sessionLabel(approval: ApprovalRequest, provider: string | undefined, noun: Noun, subject = ''): Part[] | null {
  const lead = (scope: Scope): Part[] => scope.session ? [text('Allow '), ...scope.names, text(' for this session')] : [text('Always allow '), ...scope.names]
  switch (provider) {
    case 'claude-code': {
      const scope = claudeScope(approval.suggestions)
      return scope ? lead(scope) : null
    }
    case 'opencode': return lead(opencodeScope(approval))
    case 'codex': return [text(`Allow ${codexNoun(approval, noun)} for this session`)]
    case 'pi': case 'omp': return approval.tool_call_id ? [text(`Allow ${piNoun(noun)} for this session`)] : null
    case 'cursor': return cursorAlways(approval)
    default: return [text(`Allow ${subject || 'this'} for this session`)]
  }
}

// ---- reading the request ----

/** One argv word as the shell would need it typed: quoted when it holds a space or a shell character. */
export function shellQuote(word: string): string {
  if (word && /^[A-Za-z0-9_\-./:=+@%,~^]+$/.test(word)) return word
  return `'${word.replace(/'/g, `'\\''`)}'`
}

/**
 * The real command text, never the one-line summary (`a && b` must not read as `a`). An argv array is quoted word by word, so
 * `["bash", "-lc", "a && b"]` reads as one `bash` call with its script, not as a chain.
 */
export function commandOf(input: JsonValue): string {
  const o = record(input)
  for (const source of [o, record(o.metadata), record(o.rawInput), record(o.raw_input), record(o.raw), record(o.input)]) {
    const value = source.command ?? source.cmd
    if (typeof value === 'string' && value.trim()) return value
    if (Array.isArray(value) && value.length) return value.map((word) => shellQuote(String(word))).join(' ')
  }
  return ''
}

const MAX_DIFF_CELLS = 40_000

/** A line diff: kept lines as context, then removed and added ones, in order (LCS; a replace-all past a size where it stays cheap). */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before ? before.split('\n') : [], b = after ? after.split('\n') : []
  if (a.length * b.length > MAX_DIFF_CELLS) return [...a.map((line): DiffLine => ({ kind: 'del', text: line })), ...b.map((line): DiffLine => ({ kind: 'add', text: line }))]
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
  const out: DiffLine[] = []
  let i = 0, j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { out.push({ kind: 'ctx', text: a[i]! }); i++; j++ }
    else if (j >= b.length || (i < a.length && lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) { out.push({ kind: 'del', text: a[i++]! }) }
    else out.push({ kind: 'add', text: b[j++]! })
  }
  return out
}

/** A unified diff's body lines (hunk headers and file headers dropped) as diff lines. */
function unifiedLines(patch: string): DiffLine[] {
  const out: DiffLine[] = []
  for (const line of patch.split('\n')) {
    if (/^(@@|\+\+\+|---|diff |index )/.test(line)) continue
    if (line.startsWith('+')) out.push({ kind: 'add', text: line.slice(1) })
    else if (line.startsWith('-')) out.push({ kind: 'del', text: line.slice(1) })
    else if (line.startsWith(' ')) out.push({ kind: 'ctx', text: line.slice(1) })
  }
  return out
}

const tally = (path: string, lines: DiffLine[]): DiffSpec => ({ path, lines, added: lines.filter((l) => l.kind === 'add').length, removed: lines.filter((l) => l.kind === 'del').length })

/** The change an edit approval would make: Claude's `old_string`/`new_string`, `edits` and `content`, Codex's `changes`, or a patch. */
export function editDiff(input: JsonValue): DiffSpec | null {
  const o = record(input)
  const path = string(o.file_path) || string(o.filePath) || string(o.path)
  if (typeof o.old_string === 'string' || typeof o.new_string === 'string') return tally(path, diffLines(string(o.old_string), string(o.new_string)))
  const edits = array(o.edits).map(record).filter((e) => 'old_string' in e || 'new_string' in e)
  if (edits.length) return tally(path, edits.flatMap((e) => diffLines(string(e.old_string), string(e.new_string))))
  if (typeof o.content === 'string') return tally(path, o.content.split('\n').map((line): DiffLine => ({ kind: 'add', text: line })))
  for (const key of ['patch', 'diff']) if (typeof o[key] === 'string' && o[key]) return tally(path, unifiedLines(o[key] as string))
  const changes = array(o.changes).map(record)
  if (changes.length) {
    const lines = changes.flatMap((c) => typeof c.diff === 'string' ? unifiedLines(c.diff) : [])
    const first = string(changes[0]!.path)
    return tally(changes.length > 1 ? `${basename(first)} and ${changes.length - 1} more` : first, lines)
  }
  return path ? tally(path, []) : null
}

const GRANT_NAMES: Record<string, string> = {
  external_directory: 'Access outside the workspace', edit: 'Edit files', bash: 'Run commands', webfetch: 'Fetch a web page', read: 'Read files', write: 'Write files', task: 'Start a subagent',
}
const sentence = (s: string) => { const t = s.replace(/[_-]+/g, ' ').trim(); return t.charAt(0).toUpperCase() + t.slice(1) }

/** One line per permission: OpenCode's `permission` and `patterns`, Codex's network host and write root. */
export function grantLines(input: JsonValue): GrantLine[] {
  const o = record(input)
  const lines: GrantLine[] = []
  const network = record(o.network)
  if (string(network.host)) lines.push({ name: 'Network access', target: string(network.host), glyph: 'network' })
  if (string(o.grant_root)) lines.push({ name: 'Write outside the workspace', target: string(o.grant_root), glyph: 'folder' })
  const permission = string(o.permission)
  if (permission) {
    const patterns = array(o.patterns).map(String)
    for (const pattern of patterns.length ? patterns : ['']) lines.push({ name: GRANT_NAMES[permission] ?? sentence(permission), target: pattern === '*' ? '' : pattern, glyph: /directory|path|file/.test(permission) ? 'folder' : 'tool' })
  }
  return lines
}

const deniedRow = (agent: string): RowSpec => ({ id: 'decline', label: [text(`Decline and tell ${agent} what to do instead`)], action: { kind: 'decline' } })
const decide = (id: RowSpec['id'], label: Part[], decision: ApprovalDecision): RowSpec => ({ id, label, action: { kind: 'decide', decision } })

/** The card for a tool approval or a consent request; null for forms and questions, which lay themselves out. */
export function approvalCard(approval: ApprovalRequest, provider: string | undefined, cwd?: string): CardModel | null {
  const agent = agentName(provider)
  const chip = cwd ? { label: cwd } : undefined
  const session = (noun: Noun, subject?: string) => sessionLabel(approval, provider, noun, subject)
  const withSession = (once: RowSpec, label: Part[] | null, ...rest: RowSpec[]): RowSpec[] => [once, ...(label ? [decide('session', label, { decision: 'allow_always' })] : []), ...rest]

  const connector = connectorApproval(approval)
  if (connector) return connectorCard(approval, connector, agent)
  const computer = computerConsent(approval)
  if (computer) {
    const rows = [
      // The daemon's "once" lasts the turn (`ConsentAnswer::Turn`), and "always" covers background work only.
      decide('once', [text('Allow for this turn')], { decision: 'allow_once' }),
      decide('session', [text('Allow for this session')], { decision: 'allow_always' }),
      ...(computer.foreground ? [] : [decide('always', [text(`Always allow ${computer.app} in the background`)], { decision: 'submit', response: { scope: 'always' } })]),
      deniedRow(agent),
    ]
    return {
      kind: 'computer', glyph: 'laptop', agent, rows, well: null, chip: { label: 'Computer use' },
      title: computer.foreground ? `Let this chat take over your cursor in ${computer.app}?` : `Let this chat use ${computer.app}?`,
      meta: computer.foreground ? `${computer.app} comes to the front while the agent works. Avoid typing until it finishes.` : 'It works in the background. Your cursor and keyboard stay yours.',
    }
  }
  const notes = notesTasksConsent(approval)
  if (notes) {
    return {
      kind: 'notes', glyph: notes.kind === 'task' ? 'task' : 'note', agent, well: notes.preview ? { kind: 'notes', consent: notes } : null,
      title: notes.summary ? `${notes.summary}?` : notes.kind === 'task' ? 'Allow this change to a task?' : 'Allow this change to a note?',
      meta: notesMeta(notes).join(' · ') || undefined,
      rows: [decide('once', [text('Allow once')], { decision: 'allow_once' }), decide('session', [text('Allow for this thread')], { decision: 'allow_always' }), deniedRow(agent)],
    }
  }
  if (approval.tool_name === 'ExitPlanMode') {
    const plan = string(record(approval.input).plan)
    return {
      kind: 'plan', glyph: 'plan', agent, chip: { label: 'Plan mode' }, title: 'Start implementing this plan?',
      meta: plan ? undefined : 'Review the plan above before continuing.', well: plan ? { kind: 'plan', plan } : null,
      rows: [decide('once', [text('Start implementing')], { decision: 'allow_once' }), { id: 'decline', label: [text(`Keep planning and tell ${agent} what to change`)], action: { kind: 'decline' } }],
    }
  }
  const { kind, detail } = toolLine({ id: approval.tool_call_id ?? '', name: approval.tool_name, input: approval.input })
  const command = commandOf(approval.input)
  const lines = grantLines(approval.input)
  // Codex asks for network access through a command approval with no command: that is a grant, not "Run this command?".
  if (command || (kind === 'command' && !lines.length)) {
    return { kind: 'command', glyph: 'terminal', agent, chip, title: 'Run this command?', well: { kind: 'command', command: command || detail || approval.summary }, rows: withSession(decide('once', [text('Run once')], { decision: 'allow_once' }), session('command'), deniedRow(agent)) }
  }
  if (kind === 'read') {
    return { kind: 'read', glyph: 'file', agent, chip, title: `Let ${agent} read this file?`, well: detail ? { kind: 'file', path: detail } : null, rows: withSession(decide('once', [text('Allow once')], { decision: 'allow_once' }), session('read'), deniedRow(agent)) }
  }
  if (kind === 'edit' || kind === 'write') {
    const diff = editDiff(approval.input)
    const creating = kind === 'write'
    // Codex's "accept for session" on an edit that asks for a write root also grants writes under that root.
    const root = provider === 'codex' ? string(record(approval.input).grant_root) : ''
    return {
      kind: 'edit', glyph: 'pencil', agent, chip, title: creating ? 'Create this file?' : 'Apply this edit?',
      meta: root ? `${agent} also asks to write in ${root} for the rest of the session.` : undefined,
      well: diff ? { kind: 'diff', diff } : detail ? { kind: 'file', path: detail } : null,
      rows: withSession(decide('once', [text(creating ? 'Create file' : 'Apply edit')], { decision: 'allow_once' }), root ? [text('Allow writes in '), code(root), text(' for this session')] : session('edit'), deniedRow(agent)),
    }
  }
  return {
    kind: 'grant', glyph: 'shield', agent, chip: { label: agent }, title: approval.summary && !lines.length ? `${approval.summary}?` : 'Grant these permissions?',
    well: lines.length ? { kind: 'grants', lines } : { kind: 'text', text: permissionBody(approval.input) },
    rows: withSession(decide('once', [text('Grant once')], { decision: 'allow_once' }), provider === 'codex' ? [text('Grant for this session')] : session('other'), deniedRow(agent)),
  }
}

function connectorCard(approval: ApprovalRequest, connector: ConnectorApproval, agent: string): CardModel {
  const server = string(record(approval.input).serverName) || approval.tool_name
  const rows: RowSpec[] = [decide('once', [text('Allow once')], { decision: 'submit', response: connectorApprovalResponse(null) })]
  if (connector.persist.includes('session')) rows.push(decide('session', [text('Allow '), code(connector.connector), text(' for this session')], { decision: 'submit', response: connectorApprovalResponse('session') }))
  rows.push(deniedRow(agent))
  return {
    kind: 'connector', glyph: 'plug', agent, rows, well: null, chip: { label: server },
    title: connector.app ? `Allow ${connector.connector} to use ${connector.app}?` : connector.message || `Allow ${connector.connector}?`,
    meta: connector.subtitle || `${connector.connector} will see this app’s window and click and type in it. Watch what it does.`,
  }
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

export function notesMeta(consent: NotesTasksConsent): string[] {
  switch (consent.action) {
    case 'create_task':
      return ['Lands in Inbox', ...(consent.priority > 0 && consent.priorityLabel ? [`${consent.priorityLabel} priority`] : []), ...(consent.criteria > 0 ? [plural(consent.criteria, 'criterion', 'criteria')] : [])]
    case 'update_note':
      return [...(consent.title ? [`New title “${consent.title}”`] : []), ...(consent.preview ? ['Replaces the text'] : [])]
    case 'claim_task':
      return ['Shows as Running while this chat works on it']
    default:
      return []
  }
}

/** The raw input of a request this card has no layout for, as readable text (at most the first useful field). */
export function permissionBody(input: JsonValue): string {
  if (!input || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  for (const k of ['command', 'diff', 'new_string', 'content', 'patch']) {
    const v = o[k]
    if (typeof v === 'string' && v.trim()) return v
  }
  return JSON.stringify(input, null, 2)
}

// ---- keys ----

/** The row a digit picks: digits follow the visible order, so 1 is the first row and Decline is the last number. */
export const rowForDigit = (rows: readonly RowSpec[], digit: number): RowSpec | null => rows[digit - 1] ?? null

/** The highlight after ↑ or ↓: it wraps at both ends. */
export const stepHighlight = (current: number, dir: 1 | -1, count: number): number => (count ? (current + dir + count) % count : 0)

/** The keys a card with `count` rows answers to ("1–3"), for the hint line. */
export const digitRange = (count: number): string => (count > 1 ? `1–${count}` : '1')

/** Harnesses whose driver drops a deny's `reason`, so the note goes as a follow-up message instead. Claude's driver forwards it as the deny `message`, and the daemon's own cards (computer use, notes and tasks) read it. */
export function forwardsDeclineReason(approval: ApprovalRequest, provider: string | undefined): boolean {
  if (computerConsent(approval) || notesTasksConsent(approval)) return true
  return provider === 'claude-code'
}
