// What the @ / $ picker marks as already attached, and the toggle that removes it. The source of truth is the composer's own
// text: an item is attached while its token stands in the draft as a chip, so deleting the chip in the editor, undoing a
// pick or pasting a chip back is what the row shows. Tokens are found with `tokenText`, the scan the editor draws chips with
// (the longest known token wins at a position), so the picker and the editor never disagree. Pure text work, shared by
// `Completion.tsx` (rows, picks) and `Composer.tsx` (attachment de-duplication).
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { tokenText } from './token-text.ts'

export type Range = readonly [start: number, end: number]

/** Where the editor would draw `token` as a chip, given the other `known` tokens (a longer one at the same place wins). */
export function tokenRanges(text: string, token: string, known: readonly string[] = []): Range[] {
  if (!token) return []
  return tokenText(text, [token, ...known].map((t) => ({ token: t, label: t }))).spans
    .filter((span) => span.token === token)
    .map((span) => [span.sourceStart, span.sourceEnd] as const)
}

/** Every token of `known` that stands in `text` as a chip, the picker's own trigger excepted. One scan for all rows. */
export function standingTokens(text: string, known: readonly string[], trigger: Range | null = null): Set<string> {
  return new Set(tokenText(withoutTrigger(text, trigger), known.map((t) => ({ token: t, label: t }))).spans.map((span) => span.token))
}

/** `text` with the range the user is still typing (the `@qu` that opened the picker) blanked, so it never counts as an attachment. */
export function withoutTrigger(text: string, trigger: Range | null): string {
  return trigger ? text.slice(0, trigger[0]) + ' '.repeat(Math.max(0, trigger[1] - trigger[0])) + text.slice(trigger[1]) : text
}

export const hasToken = (text: string, token: string | null | undefined, trigger: Range | null = null, known: readonly string[] = []) =>
  !!token && tokenRanges(withoutTrigger(text, trigger), token, known).length > 0

export interface TextEdit { start: number; end: number; replacement: string }

/**
 * One edit that removes every standing `token` and the picker's own trigger text. A removed token takes one neighbouring space
 * with it (the one after it, else the one before), so no gap is left; the edit spans first to last so it is one undo step.
 * `known`: the draft's other chip tokens, so a longer chip that starts with `token` (`@a.ts.bak`) is never cut.
 */
export function removalEdit(text: string, token: string, trigger: Range | null, known: readonly string[] = []): TextEdit | null {
  const spans: [number, number][] = tokenRanges(withoutTrigger(text, trigger), token, known).map(([start, end]) => {
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

/**
 * The identity of an attached file: its absolute path with `.`/`..`, doubled and trailing slashes resolved (a relative path is
 * read from the working directory, as `uploadPath` reads it), and symlinks followed when it exists. Data URIs (pasted images)
 * are their own identity.
 */
export function fileKey(path: string): string {
  if (path.startsWith('data:')) return path
  const absolute = resolve(path)
  try { return realpathSync.native(absolute) } catch { return absolute }
}

/** The files to add: paths not already attached (or repeated in this very batch), and those that were. Compared by `fileKey`. */
export function newFiles(attached: readonly { path?: string }[], paths: readonly string[], key: (path: string) => string = fileKey): { fresh: string[]; duplicates: string[] } {
  const seen = new Set(attached.flatMap((a) => (a.path ? [key(a.path)] : [])))
  const fresh: string[] = [], duplicates: string[] = []
  for (const path of paths) {
    const id = key(path)
    ;(seen.has(id) ? duplicates : fresh).push(path)
    seen.add(id)
  }
  return { fresh, duplicates }
}

/** A pasted or dropped image's identity: the digest of its bytes. */
export const contentHash = (bytes: ArrayBuffer | Uint8Array): string => createHash('sha1').update(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).digest('hex')

export const alreadyAttachedText = (names: readonly string[]) => names.length === 1 ? `${names[0]} is already attached.` : `${names.length} files are already attached.`
