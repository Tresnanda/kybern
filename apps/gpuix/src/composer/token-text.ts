import { textEdit } from '../notes/rich-text.ts'
export interface TokenReference { token: string; label: string }
export interface TokenSpan { sourceStart: number; sourceEnd: number; start: number; end: number; token: string }
export interface TokenText { source: string; text: string; spans: TokenSpan[] }
export function tokenText(source: string, references: readonly TokenReference[]): TokenText {
  const result: TokenText = { source, text: '', spans: [] }
  const refs = [...references].filter(r => r.token && r.label).sort((a, b) => b.token.length - a.token.length)
  for (let at = 0; at < source.length;) {
    const ref = refs.find(r => source.startsWith(r.token, at) && (at === 0 || /\s|[([{]/.test(source[at - 1]!)) && (at + r.token.length === source.length || /\s|[.,!?;:)\]}]/.test(source[at + r.token.length]!)))
    if (!ref) { result.text += source[at++]; continue }
    const start = result.text.length
    result.text += ref.label
    result.spans.push({ sourceStart: at, sourceEnd: at + ref.token.length, start, end: result.text.length, token: ref.token })
    at += ref.token.length
  }
  return result
}
export function tokenSourceOffset(doc: TokenText, offset: number, end = false): number {
  let delta = 0
  for (const span of doc.spans) {
    if (offset <= span.start) break
    if (offset < span.end) return end ? span.sourceEnd : span.sourceStart
    delta += (span.sourceEnd - span.sourceStart) - (span.end - span.start)
  }
  return Math.min(doc.source.length, offset + delta)
}
export function tokenDisplayOffset(doc: TokenText, offset: number, end = false): number {
  let delta = 0
  for (const span of doc.spans) {
    if (offset <= span.sourceStart) break
    if (offset < span.sourceEnd) return end ? span.end : span.start
    delta += (span.end - span.start) - (span.sourceEnd - span.sourceStart)
  }
  return Math.min(doc.text.length, offset + delta)
}
export function editTokenText(doc: TokenText, displayed: string): { value: string; caret: number } {
  const edit = textEdit(doc.text, displayed)
  const start = tokenSourceOffset(doc, edit.start), end = tokenSourceOffset(doc, edit.end, true)
  return { value: doc.source.slice(0, start) + edit.text + doc.source.slice(end), caret: start + edit.text.length }
}
