// What a command approval shows: the real `input.command` split into the commands the shell will run, so `a && b` never reads
// as `a` (the card used to show the first line summary). Pure, and display only: `CodeWell` in `Card.tsx` draws it. No allow
// rule is ever built from a segment (the session option names what the harness itself would allow, `model.ts`), so a wrong split
// can only misdraw; and when unsure, the command stays one unit.

export type ShellOp = '&&' | '||' | ';' | '|' | '|&' | '&' | '\n'

/** One command of a chain: `op` is the operator that joins it to the one before (null for the first). */
export interface ShellSegment {
  op: ShellOp | null
  /** The command text. A heredoc keeps its body after the first line. */
  text: string
}

/** The gutter glyph of a segment: `$` for the first command and for one on a new line, else the operator. */
export const gutterOf = (op: ShellOp | null): string => (op === null || op === '\n' ? '$' : op)

const WORD = /^[A-Za-z0-9_\-./:=+@%,~]+$/

/** Where a `#` starts a comment and `[[` a test: at the start of a word. */
const WORD_START = new Set([undefined, ' ', '\t', '\n', ';', '&', '|', '(', ')'])
/** Characters that end a heredoc delimiter word. */
const DELIMITER_END = /[\s;&|<>()]/

/** The heredoc delimiter that starts at `s[i]` (just after `<<`): the word with its quotes and escapes removed, where it ends and whether `<<-` strips tabs. */
function heredocDelimiter(s: string, i: number): { delimiter: string; end: number; strip: boolean } | null {
  let j = i
  const strip = s[j] === '-'
  if (strip) j++
  while (s[j] === ' ' || s[j] === '\t') j++
  let delimiter = ''
  const start = j
  while (j < s.length && !DELIMITER_END.test(s[j]!)) {
    const c = s[j]!
    if (c === "'" || c === '"') {
      const close = s.indexOf(c, j + 1)
      if (close < 0) return null
      delimiter += s.slice(j + 1, close)
      j = close + 1
    } else if (c === '\\') { delimiter += s[j + 1] ?? ''; j += 2 } else { delimiter += c; j++ }
  }
  if (j === start || !delimiter) return null
  return { delimiter, end: j, strip }
}

/** A context the splitter is inside: quotes, `$(…)`, `(…)`, `$((…))`/`((…))`, `${…}`, backticks and `[[ … ]]`. */
type Context = "'" | '"' | '$(' | '(' | '((' | '${' | '`' | '[['

/** Non-space text with line continuations removed: what a split may rearrange but never lose or add. */
const essence = (text: string) => text.replace(/\\\n/g, '').replace(/\s+/g, '')

/**
 * Splits a command on `&&`, `||`, `;`, `|`, `|&`, a background `&` and unquoted newlines. Quotes, escapes, `$(…)`, `(…)`, `((…))`,
 * `${…}`, backticks (nested too), `[[ … ]]`, comments and heredoc bodies are never split, and neither are `case` terminators
 * (`;;`, `;&`). Redirections (`2>&1`, `&>`, `<&3`, `>|`) keep their operator. Empty segments drop.
 *
 * When the command does not read as a plain chain (an operator with no command before it, a chain ending in `&&`, or a split
 * that would not keep every character), it comes back whole as one segment: the well must show exactly what runs.
 */
export function splitShell(command: string): ShellSegment[] {
  const s = command.replace(/\r\n?/g, '\n')
  const out: ShellSegment[] = []
  let cur = ''
  let op: ShellOp | null = null
  let unsure = false
  const stack: Context[] = []
  let heredocs: { delimiter: string; strip: boolean }[] = []
  const whole = (): ShellSegment[] => (s.trim() ? [{ op: null, text: s.trim() }] : [])
  const flush = (next: ShellOp | null) => {
    const text = cur.trim()
    cur = ''
    if (text) { out.push({ op: out.length ? op ?? '\n' : null, text }); op = next; return }
    if (next === null || next === '\n') return
    // An operator with no command before it (`&& a`, `a; ; b`): not a plain chain.
    unsure = true
    op = next
  }
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    const next = s[i + 1]
    const top = stack[stack.length - 1]
    if (top === "'") { cur += c; if (c === "'") stack.pop(); continue }
    if (c === '\\') {
      // A line continuation joins the lines; any other escape keeps the next character as it is.
      if (next === '\n') { if (!/\s$/.test(cur)) cur += ' '; i++; while (s[i + 1] === ' ' || s[i + 1] === '\t') i++; continue }
      cur += c + (next ?? ''); i++; continue
    }
    if (top === '"') {
      cur += c
      if (c === '"') stack.pop()
      else if (c === '`') stack.push('`')
      else if (c === '$' && next === '(') { cur += next; i++; stack.push('$(') } else if (c === '$' && next === '{') { cur += next; i++; stack.push('${') }
      continue
    }
    // Code: the top level and the inside of `$(…)`, `(…)`, `((…))`, `${…}`, backticks and `[[ … ]]`.
    if (c === "'" || c === '"') { stack.push(c); cur += c; continue }
    if (c === '`') { if (top === '`') stack.pop(); else stack.push('`'); cur += c; continue }
    if (c === '$' && next === '{') { stack.push('${'); cur += '${'; i++; continue }
    if (c === '$' && next === '(' && s[i + 2] === '(') { stack.push('(('); cur += '$(('; i += 2; continue }
    if (c === '$' && next === '(') { stack.push('$('); cur += '$('; i++; continue }
    if (c === '(' && next === '(' && top !== '((') { stack.push('(('); cur += '(('; i++; continue }
    if (c === '(') { stack.push('('); cur += c; continue }
    if (c === ')' && top === '((' && next === ')') { stack.pop(); cur += '))'; i++; continue }
    if (c === ')' && (top === '$(' || top === '(')) { stack.pop(); cur += c; continue }
    if (c === '}' && top === '${') { stack.pop(); cur += c; continue }
    if (c === '[' && next === '[' && WORD_START.has(s[i - 1]) && /\s/.test(s[i + 2] ?? '') && top !== '((' && top !== '${') { stack.push('[['); cur += '[['; i++; continue }
    if (c === ']' && next === ']' && top === '[[' && /\s/.test(s[i - 1] ?? '') && (s[i + 2] === undefined || /[\s;&|)]/.test(s[i + 2]!))) { stack.pop(); cur += ']]'; i++; continue }
    if (c === '#' && WORD_START.has(s[i - 1]) && top !== '`' && top !== '${' && top !== '((' && top !== '[[') {
      while (i < s.length && s[i] !== '\n') { cur += s[i]; i++ }
      i--; continue
    }
    if (c === '<' && next === '<' && s[i + 2] !== '<' && s[i - 1] !== '<' && top !== '((' && top !== '${' && top !== '[[') {
      const found = heredocDelimiter(s, i + 2)
      if (found) { heredocs.push({ delimiter: found.delimiter, strip: found.strip }); cur += s.slice(i, found.end); i = found.end - 1; continue }
    }
    if (c === '\n' && heredocs.length) {
      // The bodies follow this line, at any depth: copy them whole, up to and including each delimiter line.
      let pos = i + 1
      let body = ''
      for (const { delimiter, strip } of heredocs) {
        while (pos <= s.length) {
          const end = s.indexOf('\n', pos)
          const line = s.slice(pos, end < 0 ? s.length : end)
          body += `\n${line}`
          pos = end < 0 ? s.length + 1 : end + 1
          if ((strip ? line.replace(/^\t+/, '') : line) === delimiter) break
        }
      }
      cur += body
      heredocs = []
      // Resume on the newline that ends the last delimiter line (it separates the next command).
      i = pos - 2
      continue
    }
    if (stack.length) { cur += c; continue }
    if (c === '\n') { flush('\n'); continue }
    if (c === '&') {
      if (next === '&') { flush('&&'); i++; continue }
      if (s[i - 1] === '>' || s[i - 1] === '<' || next === '>') { cur += c; continue }
      flush('&')
      continue
    }
    if (c === '|') {
      if (next === '|') { flush('||'); i++; continue }
      if (s[i - 1] === '>') { cur += c; continue }
      if (next === '&') { flush('|&'); i++; continue }
      flush('|')
      continue
    }
    if (c === ';') {
      // `;;`, `;&` and `;;&` end a `case` branch: not a chain.
      if (next === ';' || next === '&') { cur += c + next; i++; if (s[i + 1] === '&') { cur += '&'; i++ } continue }
      flush(';')
      continue
    }
    cur += c
  }
  flush(null)
  // What is left after the last command: a background `&` stays on it, a trailing `;` or newline means nothing, and a dangling
  // `&&`, `||` or `|` is not a whole command.
  let trailing = ''
  if (op === '&' && out.length) { out[out.length - 1] = { ...out[out.length - 1]!, text: `${out[out.length - 1]!.text} &` } } else if (op === ';') trailing = ';'
  else if (op !== null && op !== '\n') unsure = true
  if (unsure) return whole()
  const rebuilt = out.map((segment) => (segment.op && segment.op !== '\n' ? segment.op : '') + segment.text).join('') + trailing
  return essence(rebuilt) === essence(s) ? out : whole()
}

export type TokenKind = 'cmd' | 'arg' | 'flag' | 'str' | 'op' | 'var' | 'body' | 'comment'
export interface ShellToken { text: string; kind: TokenKind }

/** The words of one command line, coloured by role: the command, flags, quoted strings, redirections and `VAR=` prefixes. */
export function shellTokens(line: string): ShellToken[] {
  const words: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  const push = () => { if (cur) words.push(cur); cur = '' }
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (quote) { cur += c; if (c === '\\' && quote === '"') { cur += line[i + 1] ?? ''; i++ } else if (c === quote) quote = null; continue }
    if (c === '\\') { cur += c + (line[i + 1] ?? ''); i++; continue }
    if (c === '"' || c === "'") { quote = c; cur += c; continue }
    if (c === ' ' || c === '\t') { push(); continue }
    if (c === '#' && !cur) { push(); words.push(line.slice(i)); break }
    cur += c
  }
  push()
  let seenCommand = false
  return words.map((w): ShellToken => {
    if (w.startsWith('#')) return { text: w, kind: 'comment' }
    if (/^\d*(>>?|<<?<?|>&|<&|&>>?)/.test(w)) return { text: w, kind: 'op' }
    if (/^["']/.test(w)) return { text: w, kind: 'str' }
    if (!seenCommand && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) return { text: w, kind: 'var' }
    if (!seenCommand) { seenCommand = true; return { text: w, kind: 'cmd' } }
    if (/^-/.test(w)) return { text: w, kind: 'flag' }
    return { text: w, kind: /["']/.test(w) && !WORD.test(w) ? 'str' : 'arg' }
  })
}

/** One drawn line of the well: the gutter glyph and the text; a heredoc body line has no gutter and no colours. */
export interface CodeRow { gutter: string; text: string; body: boolean }

/** Every line the shell will see, a segment's heredoc body included. */
export function commandRows(command: string): CodeRow[] {
  const rows: CodeRow[] = []
  for (const segment of splitShell(command)) {
    const [first = '', ...rest] = segment.text.split('\n')
    rows.push({ gutter: gutterOf(segment.op), text: first, body: false })
    for (const line of rest) rows.push({ gutter: '', text: line, body: true })
  }
  return rows
}

/** Roughly how many characters of 12 pt Menlo fit one line of the well at the card's width. */
export const WELL_COLUMNS = 84

const wrapped = (text: string, columns: number) => Math.max(1, Math.ceil(text.length / columns))

/**
 * At most `max` lines of the well: a row that wraps counts for every line it takes, and a single row longer than the whole
 * budget is cut. `total` is the line count of the whole command, for "Show all N lines".
 */
export function clampRows(rows: CodeRow[], max = 6, columns = WELL_COLUMNS): { rows: CodeRow[]; total: number; clamped: boolean } {
  const total = rows.reduce((n, row) => n + wrapped(row.text, columns), 0)
  if (total <= max) return { rows, total, clamped: false }
  const shown: CodeRow[] = []
  let used = 0
  for (const row of rows) {
    const lines = wrapped(row.text, columns)
    if (used + lines > max) {
      if (!shown.length) shown.push({ ...row, text: row.text.slice(0, max * columns - 1).trimEnd() + '…' })
      break
    }
    shown.push(row)
    used += lines
  }
  return { rows: shown, total, clamped: true }
}

/** Every command word the segments run (`cd`, `pnpm`, …). For display only: never build an allow rule from it. */
export const commandNames = (command: string): string[] =>
  splitShell(command).map((segment) => shellTokens(segment.text.split('\n')[0] ?? '').find((token) => token.kind === 'cmd')?.text ?? '').filter(Boolean)
