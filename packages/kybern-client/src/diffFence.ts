// `diff` and `patch` fences in Markdown (#294), told apart from other code: which lines were removed, added or are
// hunk headers, and where such fences sit in a longer document. Pure text work, shared by the transcript, pull
// request and issue bodies, notes and every other place Markdown is drawn.

export type DiffKind = 'add' | 'del' | 'hunk' | 'plain'

/** One line of a diff fence by what it is. */
export interface DiffRun {
  kind: DiffKind
  /** The run's lines joined by newlines (no trailing newline). Joined with `\n` the runs are the fence exactly. */
  text: string
}

/** The fence tags that mean a diff. */
export function isDiffLanguage(language?: string): boolean {
  const tag = (language ?? '').trim().split(/\s+/)[0]!.toLowerCase()
  return tag === 'diff' || tag === 'patch'
}

const HEADER_LINES = /^(?:diff |index [0-9a-f]|new file mode|deleted file mode|old mode|new mode|similarity index|dissimilarity index|rename (?:from|to) |copy (?:from|to) |Binary files |\\ )/

/**
 * Each line's kind. `@@` hunk headers and the lines git puts above them are `hunk` (muted); `---` / `+++` are headers
 * only as a pair (`-- comment` removed from SQL is `--- comment` in a diff and stays a removal); context stays plain.
 */
export function diffKinds(lines: readonly string[]): DiffKind[] {
  return lines.map((line, i): DiffKind => {
    if (line.startsWith('@@') || HEADER_LINES.test(line)) return 'hunk'
    if (line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) return 'hunk'
    if (line.startsWith('+++ ') && lines[i - 1]?.startsWith('--- ')) return 'hunk'
    if (line.startsWith('+')) return 'add'
    if (line.startsWith('-')) return 'del'
    return 'plain'
  })
}

/** `text` as runs of neighbouring lines of one kind: few elements, however many lines. */
export function diffRuns(text: string): DiffRun[] {
  const lines = text.split('\n')
  const kinds = diffKinds(lines)
  const runs: DiffRun[] = []
  let start = 0
  for (let i = 1; i <= lines.length; i++) {
    if (i < lines.length && kinds[i] === kinds[start]) continue
    runs.push({ kind: kinds[start]!, text: lines.slice(start, i).join('\n') })
    start = i
  }
  return runs
}

/**
 * A piece of a Markdown document: prose to draw as Markdown, or a diff fence to draw as a diff. A diff's `text` has `\n`
 * line ends (what is drawn); `raw` is the fence body exactly as the source has it, CRLF included (what Copy reads).
 */
export type FenceSegment = { kind: 'markdown'; text: string } | { kind: 'diff'; text: string; raw: string; language: string }

const DIFF_OPEN = /^(?:`{3,}|~{3,})[ \t]*(?:diff|patch)\b/im
/** Any fence marker at any indentation: indent, marker, info string. */
const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/

/** A cheap test that comes before any splitting: most Markdown has no diff fence and is left alone. */
export function hasDiffFence(source: string): boolean {
  return source.includes('diff') || source.includes('patch') ? DIFF_OPEN.test(source) : false
}

/**
 * `source` cut at its top-level `diff` / `patch` fences (opened at the start of the line: an indented fence belongs to the list item or quote around it). A fence
 * inside a list item, a quote or another fence stays in the Markdown, where its own block draws it. An unfinished fence
 * (a reply still streaming) runs to the end. Every other character stays in the `markdown` segments, in order.
 */
export function splitDiffFences(source: string): FenceSegment[] {
  // GitHub sends CRLF; a stray carriage return would keep every fence line from matching. The line ends are kept apart
  // (`ends[i]` follows `lines[i]`) so a fence's raw body can be put back together exactly.
  const lines: string[] = []
  const ends: string[] = []
  for (const [i, part] of source.split(/(\r?\n)/).entries()) (i % 2 ? ends : lines).push(part)
  const segments: FenceSegment[] = []
  let prose: string[] = []
  const flush = () => {
    if (prose.length) segments.push({ kind: 'markdown', text: prose.join('\n') })
    prose = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const open = FENCE.exec(line)
    if (!open || open[2]![0] === '`' && open[3]!.includes('`')) {
      prose.push(line)
      continue
    }
    const marker = open[2]!
    const info = open[3]!.trim()
    const diff = open[1]!.length === 0 && isDiffLanguage(info)
    let close = i + 1
    while (close < lines.length) {
      const end = FENCE.exec(lines[close]!)
      if (end && end[2]![0] === marker[0] && end[2]!.length >= marker.length && !end[3]!.trim()) break
      close++
    }
    if (!diff) {
      prose.push(...lines.slice(i, Math.min(close + 1, lines.length)))
      i = close
      continue
    }
    flush()
    const body = lines.slice(i + 1, close)
    const raw = body.map((line, k) => (k < body.length - 1 ? line + ends[i + 1 + k]! : line)).join('')
    segments.push({ kind: 'diff', text: body.join('\n'), raw, language: info.split(/\s+/)[0]!.toLowerCase() })
    i = close
  }
  flush()
  return segments
}
