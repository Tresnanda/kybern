// What a command approval shows: the real `input.command` split into the commands the shell will run, so `a && b` never reads
// as `a` (the card used to show the first line summary). Pure; `requests/CodeWell.tsx` draws it and `requests/model.ts` names
// the session scope from it.

export type ShellOp = '&&' | '||' | ';' | '|' | '|&' | '&' | '\n'

/** One command of a chain: `op` is the operator that joins it to the one before (null for the first). */
export interface ShellSegment {
  op: ShellOp | null
  /** The command text. A heredoc keeps its body after the first line. */
  text: string
}

/** The gutter glyph of a segment: `$` for the first command and for one on a new line, else the operator. */
export const gutterOf = (op: ShellOp | null): string => (op === null || op === '\n' ? '$' : op)

const isSpace = (c: string | undefined) => c === ' ' || c === '\t' || c === undefined
const WORD = /^[A-Za-z0-9_\-./:=+@%,~]+$/

/** The heredoc delimiter that starts at `s[i]` (just after `<<`), with where the delimiter word ends and whether `<<-` stripped tabs. */
function heredocDelimiter(s: string, i: number): { delimiter: string; end: number; strip: boolean } | null {
  let j = i
  const strip = s[j] === '-'
  if (strip) j++
  while (s[j] === ' ' || s[j] === '\t') j++
  const quote = s[j] === '"' || s[j] === "'" ? s[j] : null
  if (quote) j++
  const start = j
  while (j < s.length && (quote ? s[j] !== quote : /[A-Za-z0-9_\-.]/.test(s[j]!))) j++
  if (j === start) return null
  const delimiter = s.slice(start, j)
  return { delimiter, end: quote ? j + 1 : j, strip }
}

/**
 * Splits a command on `&&`, `||`, `;`, `|`, `|&`, a background `&` and unquoted newlines. Quotes, escapes, `$(…)`/`(…)`/backtick
 * groups, comments and heredoc bodies are never split. Redirections (`2>&1`, `&>`, `<&3`) keep their `&`. Empty segments drop.
 */
export function splitShell(command: string): ShellSegment[] {
  const s = command.replace(/\r\n?/g, '\n')
  const out: ShellSegment[] = []
  let cur = ''
  let op: ShellOp | null = null
  let quote: '"' | "'" | null = null
  let depth = 0
  let backtick = false
  let heredocs: { delimiter: string; strip: boolean }[] = []
  const flush = (next: ShellOp | null) => {
    const text = cur.trim()
    if (text) { out.push({ op: out.length ? op ?? '\n' : null, text }); op = next } else if (next && next !== '\n') op = next
    cur = ''
  }
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (quote === "'") { cur += c; if (c === "'") quote = null; continue }
    if (c === '\\') {
      if (s[i + 1] === '\n') { if (!/\s$/.test(cur)) cur += ' '; i++; while (s[i + 1] === ' ' || s[i + 1] === '\t') i++; continue }
      cur += c + (s[i + 1] ?? ''); i++; continue
    }
    if (quote === '"') {
      cur += c
      if (c === '"') quote = null
      continue
    }
    if (c === "'" || c === '"') { quote = c; cur += c; continue }
    if (c === '`') { backtick = !backtick; cur += c; continue }
    if (c === '#' && isSpace(s[i - 1]) && !backtick) { while (i < s.length && s[i] !== '\n') { cur += s[i]; i++ } i--; continue }
    if (c === '(' || (c === '{' && s[i - 1] === '$')) { depth++; cur += c; continue }
    if ((c === ')' || c === '}') && depth > 0) { depth--; cur += c; continue }
    if (depth > 0 || backtick) { cur += c; continue }
    if (c === '<' && s[i + 1] === '<' && s[i + 2] !== '<') {
      const found = heredocDelimiter(s, i + 2)
      if (found) { heredocs.push({ delimiter: found.delimiter, strip: found.strip }); cur += s.slice(i, found.end); i = found.end - 1; continue }
    }
    if (c === '\n') {
      if (heredocs.length) {
        // The bodies follow this line: copy them whole, up to and including each delimiter line.
        let pos = i + 1
        for (const { delimiter, strip } of heredocs) {
          let body = '\n'
          while (pos <= s.length) {
            const end = s.indexOf('\n', pos)
            const line = s.slice(pos, end < 0 ? s.length : end)
            body += line
            pos = end < 0 ? s.length + 1 : end + 1
            if ((strip ? line.replace(/^\t+/, '') : line) === delimiter) break
            body += '\n'
          }
          cur += body
        }
        heredocs = []
        i = pos - 2
        continue
      }
      flush('\n')
      continue
    }
    if (c === '&') {
      if (s[i + 1] === '&') { flush('&&'); i++; continue }
      if (s[i - 1] === '>' || s[i - 1] === '<' || s[i + 1] === '>') { cur += c; continue }
      flush('&')
      continue
    }
    if (c === '|') {
      if (s[i + 1] === '|') { flush('||'); i++; continue }
      if (s[i + 1] === '&') { flush('|&'); i++; continue }
      flush('|')
      continue
    }
    if (c === ';') { flush(';'); continue }
    cur += c
  }
  flush(null)
  return out
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

/** Every command word the segments run (`cd`, `pnpm`, …), for the session option's "and N more". */
export const commandNames = (command: string): string[] =>
  splitShell(command).map((segment) => shellTokens(segment.text.split('\n')[0] ?? '').find((token) => token.kind === 'cmd')?.text ?? '').filter(Boolean)
