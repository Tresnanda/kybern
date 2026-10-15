import type { InputDecoration } from './api.ts'
export interface InputMarkColors { textSecondary: string; accent: string; buttonSecondary: string }

/** Decorate known reference tokens; never infer a mention from arbitrary @text. */
export function referenceDecorations(text: string, references: readonly { token: string; label: string }[], colors: InputMarkColors): InputDecoration[] {
  const result: InputDecoration[] = []
  const tokens = [...new Set(references.map(r => r.token))].filter(Boolean).sort((a, b) => b.length - a.length)
  for (let index = 0; index < text.length;) {
    const token = tokens.find(token => text.startsWith(token, index) && (index === 0 || /\s|[([{]/.test(text[index - 1]!)) && (index + token.length === text.length || /\s|[.,!?;:)\]}]/.test(text[index + token.length]!)))
    if (!token) { index++; continue }
    result.push({ start: index, end: index + token.length, id: `reference:${index}:${token}`, atomic: true, style: { color: colors.accent, backgroundColor: colors.buttonSecondary, fontWeight: 600 } })
    index += token.length
  }
  return result
}

/** Source-mode inline marks: delimiters/URLs stay visible and offsets stay exact.
 * Deliberately limited to single-line backticks, **bold**, *italic*, and simple
 * Markdown links; not a CommonMark parser or a rich-document replacement.
 */
export function markdownInputDecorations(text: string, colors: InputMarkColors): InputDecoration[] {
  const result: InputDecoration[] = []
  const occupied: { start: number; end: number }[] = []
  const escaped = (at: number) => { let n = 0; while (at > 0 && text[--at] === '\\') n++; return n % 2 === 1 }
  const available = (start: number, end: number) => !escaped(start) && !occupied.some(r => start < r.end && r.start < end)
  const add = (pattern: RegExp, style: InputDecoration['style'], edge: number) => {
    for (const match of text.matchAll(pattern)) {
      const start = match.index!, end = start + match[0].length
      if (!available(start, end)) continue
      result.push({ start: start + edge, end: end - edge, style })
      result.push({ start, end: start + edge, style: { color: colors.textSecondary } }, { start: end - edge, end, style: { color: colors.textSecondary } })
      occupied.push({ start, end })
    }
  }
  add(/`[^`\n]+`/g, { backgroundColor: colors.buttonSecondary }, 1)
  for (const match of text.matchAll(/\[([^\]\n]+)\]\(([^\s()]+)\)/g)) {
    const start = match.index!, end = start + match[0].length
    if (!available(start, end)) continue
    const task = /^kybern:\/\/task\/[a-f\d-]{36}$/i.test(match[2]!)
    result.push({ start: task ? start : start + 1, end: task ? end : start + 1 + match[1]!.length,
      id: `link:${start}:${match[2]}`, atomic: task,
      style: { color: colors.accent, underline: !task, ...(task ? { backgroundColor: colors.buttonSecondary, fontWeight: 600 } : {}) } })
    occupied.push({ start, end })
  }
  add(/\*\*[^*\n]+\*\*/g, { fontWeight: 700 }, 2)
  add(/(?<!\*)\*[^*\n]+\*(?!\*)/g, { fontStyle: 'italic' }, 1)
  return result
}
