import type { InputDecoration } from './api.ts'
import type { Theme } from '../theme.ts'
export interface InputMarkColors { textSecondary: string; accent: string; buttonSecondary: string; text?: string; taskText?: string; codeBackground?: string }

/** CSS foreground/transparent mixes used by notes.css, resolved for native paint. */
function tint(color: string, alpha: number): string {
  if (/^#[a-f\d]{6}$/i.test(color)) return `rgba(${parseInt(color.slice(1, 3), 16)},${parseInt(color.slice(3, 5), 16)},${parseInt(color.slice(5, 7), 16)},${alpha})`
  const rgb = color.match(/^rgba?\(([^)]+)\)$/)
  if (rgb) { const v = rgb[1]!.split(/[\s,/]+/).filter(Boolean).map(Number); return `rgba(${v[0]},${v[1]},${v[2]},${(v[3] ?? 1) * alpha})` }
  // Native accepts CSS oklch, including alpha; theme custom colors may use it.
  const oklch = color.match(/^oklch\(([^/)]*)(?:\/[^)]*)?\)$/)
  if (oklch) return `oklch(${oklch[1]!.trim()} / ${alpha})`
  return color
}
export function noteInputMarkColors(t: Theme): InputMarkColors {
  const text = t.v('--foreground')
  return { text, textSecondary: t.textSecondary, accent: t.v('--color-token-text-link-foreground'), buttonSecondary: t.buttonSecondary,
    taskText: tint(text, 0.6), codeBackground: tint(text, t.variant === 'dark' ? 0.05 : 0.04) }
}

/** Decorate known reference tokens; never infer a mention from arbitrary @text. */
export function referenceDecorations(text: string, references: readonly { token: string; label: string }[], colors: InputMarkColors): InputDecoration[] {
  const result: InputDecoration[] = []
  const tokens = [...new Set(references.map(r => r.token))].filter(Boolean).sort((a, b) => b.length - a.length)
  for (let index = 0; index < text.length;) {
    const token = tokens.find(token => text.startsWith(token, index) && (index === 0 || /\s|[([{]/.test(text[index - 1]!)) && (index + token.length === text.length || /\s|[.,!?;:)\]}]/.test(text[index + token.length]!)))
    if (!token) { index++; continue }
    result.push({ start: index, end: index + token.length, id: `reference:${index}:${token}`, atomic: true, style: { color: colors.accent, fontWeight: 500 } })
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
  add(/`[^`\n]+`/g, { color: colors.text, backgroundColor: colors.codeBackground ?? colors.buttonSecondary, borderRadius: 5 }, 1)
  for (const match of text.matchAll(/\[([^\]\n]+)\]\(([^\s()]+)\)/g)) {
    const start = match.index!, end = start + match[0].length
    if (!available(start, end)) continue
    const task = /^kybern:\/\/task\/[a-f\d-]{36}$/i.test(match[2]!)
    result.push({ start: task ? start : start + 1, end: task ? end : start + 1 + match[1]!.length,
      id: `link:${start}:${match[2]}`, atomic: task,
      style: { color: task ? (colors.taskText ?? colors.textSecondary) : colors.accent, underline: !task } })
    occupied.push({ start, end })
  }
  add(/\*\*[^*\n]+\*\*/g, { fontWeight: 600, color: colors.text }, 2)
  add(/(?<!\*)\*[^*\n]+\*(?!\*)/g, { fontStyle: 'italic' }, 1)
  return result
}
