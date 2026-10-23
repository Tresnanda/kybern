import { textEdit } from '../notes/rich-text.ts'
/** `icon` is the glyph the chip leads with: its room is two monospace spaces before the label (`ICON_PAD`), under the native icon. */
export interface TokenReference { token: string; label: string; icon?: string }
export const ICON_PAD = '  '
export interface TokenSpan { sourceStart: number; sourceEnd: number; start: number; end: number; token: string }
export interface TokenText { source: string; text: string; spans: TokenSpan[] }
export function tokenText(source: string, references: readonly TokenReference[]): TokenText {
  const result: TokenText = { source, text: '', spans: [] }
  const refs = [...references].filter(r => r.token && r.label).sort((a, b) => b.token.length - a.token.length)
  for (let at = 0; at < source.length;) {
    const ref = refs.find(r => source.startsWith(r.token, at) && (at === 0 || /\s|[([{]/.test(source[at - 1]!)) && (at + r.token.length === source.length || /\s|[.,!?;:)\]}]/.test(source[at + r.token.length]!)))
    if (!ref) { result.text += source[at++]; continue }
    const start = result.text.length
    result.text += (ref.icon ? ICON_PAD : '') + ref.label
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
/**
 * A minimal display edit (`textEdit`) widened to whole chips. Chips are atomic native runs, and the common prefix of two chip
 * labels is often their shared icon room, so the bare diff can start (or end) inside a chip that the edit really removes or
 * replaces; the native input then treats the half-covered run unpredictably (removing a chip took its neighbours with it).
 * The widened range replaces the same text with the same result.
 */
export function snapToChips(previous: TokenText, next: TokenText, edit: { start: number; end: number; text: string }): { start: number; end: number; text: string } {
  let { start, end } = edit
  const delta = previous.text.length - next.text.length
  // Widening one edge to a chip of one document can land it inside a chip of the other, so both edges are widened until
  // neither moves (spans only grow the range, so this ends).
  for (let moved = true; moved;) {
    moved = false
    // The prefix is shared, so a chip of either document that straddles `start` starts the range earlier.
    for (const span of [...previous.spans, ...next.spans]) if (span.start < start && start < span.end) { start = span.start; moved = true }
    // The suffix is shared too, but `next` counts from its own end.
    for (const span of previous.spans) if (span.start < end && end < span.end) { end = span.end; moved = true }
    for (const span of next.spans) if (span.start < end - delta && end - delta < span.end) { end = span.end + delta; moved = true }
  }
  return { start, end, text: previous.text.slice(start, edit.start) + edit.text + previous.text.slice(edit.end, end) }
}
