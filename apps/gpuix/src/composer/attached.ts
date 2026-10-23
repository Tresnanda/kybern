// What the @ / $ picker marks as already attached, and the toggle that removes it. The source of truth is the composer's own
// text: an item is attached while its token stands in the draft, so deleting the chip in the editor un-marks the row. Pure
// text work, shared by `Completion.tsx` (rows, picks) and `Composer.tsx` (attachment de-duplication).
import { createHash } from 'node:crypto'

export type Range = readonly [start: number, end: number]

/** The same boundary rule as `tokenText`: a token starts the text or follows whitespace or an opening bracket, and ends it or precedes whitespace or closing punctuation. */
export function tokenRanges(text: string, token: string): Range[] {
  const found: Range[] = []
  if (!token) return found
  for (let at = text.indexOf(token); at >= 0; at = text.indexOf(token, at + token.length)) {
    const before = text[at - 1], after = text[at + token.length]
    if ((before === undefined || /\s|[([{]/.test(before)) && (after === undefined || /\s|[.,!?;:)\]}]/.test(after))) found.push([at, at + token.length])
  }
  return found
}

/** `text` with the range the user is still typing (the `@qu` that opened the picker) blanked, so it never counts as an attachment. */
export function withoutTrigger(text: string, trigger: Range | null): string {
  return trigger ? text.slice(0, trigger[0]) + ' '.repeat(Math.max(0, trigger[1] - trigger[0])) + text.slice(trigger[1]) : text
}

export const hasToken = (text: string, token: string | null | undefined, trigger: Range | null = null) => !!token && tokenRanges(withoutTrigger(text, trigger), token).length > 0

export interface TextEdit { start: number; end: number; replacement: string }

/**
 * One edit that removes every standing `token` and the picker's own trigger text. A removed token takes one neighbouring space
 * with it (the one after it, else the one before), so no gap is left; the edit spans first to last so it is one undo step.
 */
export function removalEdit(text: string, token: string, trigger: Range | null): TextEdit | null {
  const spans: [number, number][] = tokenRanges(withoutTrigger(text, trigger), token).map(([start, end]) => {
    if (/\s/.test(text[end] ?? '') && text[end] !== '\n') return [start, end + 1]
    if (start > 0 && /\s/.test(text[start - 1]!) && text[start - 1] !== '\n') return [start - 1, end]
    return [start, end]
  })
  if (trigger) spans.push([trigger[0], trigger[1]])
  if (!spans.length) return null
  spans.sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []
  for (const span of spans) {
    const last = merged[merged.length - 1]
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1])
    else merged.push([...span])
  }
  const start = merged[0]![0], end = merged[merged.length - 1]![1]
  let replacement = '', at = start
  for (const [from, to] of merged) { replacement += text.slice(at, from); at = to }
  return { start, end, replacement }
}

/** The files to add: paths not already attached (or repeated in this very batch), and those that were. Compared by path as given. */
export function newFiles(attached: readonly { path?: string }[], paths: readonly string[]): { fresh: string[]; duplicates: string[] } {
  const seen = new Set(attached.flatMap((a) => (a.path ? [a.path] : [])))
  const fresh: string[] = [], duplicates: string[] = []
  for (const path of paths) (seen.has(path) ? duplicates : fresh).push(path), seen.add(path)
  return { fresh, duplicates }
}

/** A pasted or dropped image's identity: the digest of its bytes. */
export const contentHash = (bytes: ArrayBuffer | Uint8Array): string => createHash('sha1').update(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).digest('hex')

export const alreadyAttachedText = (names: readonly string[]) => names.length === 1 ? `${names[0]} is already attached.` : `${names.length} files are already attached.`
