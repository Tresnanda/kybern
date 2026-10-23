import { expect, test } from 'bun:test'
import { alreadyAttachedText, contentHash, hasToken, newFiles, removalEdit, tokenRanges, withoutTrigger } from './attached.ts'

const apply = (text: string, edit: { start: number; end: number; replacement: string } | null) => edit ? text.slice(0, edit.start) + edit.replacement + text.slice(edit.end) : text

test('a token counts only as a whole token', () => {
  expect(tokenRanges('look at @image1 and @image10', '@image1')).toEqual([[8, 15]])
  expect(tokenRanges('(@a.ts), @a.ts.', '@a.ts')).toEqual([[1, 6], [9, 14]])
  expect(tokenRanges('mail@a.ts', '@a.ts')).toEqual([])
  expect(tokenRanges('x', '')).toEqual([])
})

test('the token the user is still typing never marks its own row', () => {
  // `$review` fully typed, picker open on it: the row is not "attached" until it is picked.
  expect(hasToken('use $review', '$review', [4, 11])).toBe(false)
  expect(hasToken('use $review $review', '$review', [12, 19])).toBe(true)
  expect(withoutTrigger('ab@cd', [2, 5])).toBe('ab   ')
})

test('picking an attached item again removes its token and the trigger in one edit, leaving no gap', () => {
  // `@src/a.ts ` is attached; the user types `@a` and picks the same file again.
  const text = 'fix @src/a.ts now @a'
  const edit = removalEdit(text, '@src/a.ts', [18, 20])
  expect(apply(text, edit)).toBe('fix now ')
  // At the start, at the end, and alone.
  expect(apply('@x tail @', removalEdit('@x tail @', '@x', [8, 9]))).toBe('tail ')
  expect(apply('head @x @', removalEdit('head @x @', '@x', [8, 9]))).toBe('head ')
  expect(apply('@x', removalEdit('@x', '@x', null))).toBe('')
  // A token before a newline keeps the line break, and takes the space before it.
  expect(apply('a @x\nb', removalEdit('a @x\nb', '@x', null))).toBe('a\nb')
  // Every occurrence goes.
  expect(apply('@x a @x', removalEdit('@x a @x', '@x', null))).toBe('a')
  expect(removalEdit('nothing here', '@x', null)).toBeNull()
})

test('files already attached are skipped by path, and a path repeated in one batch is added once', () => {
  const attached = [{ path: '/a/one.png' }, { path: 'data:image/png;base64,AAAA' }, {}]
  expect(newFiles(attached, ['/a/one.png', '/a/two.png', '/a/two.png', '/a/three.pdf'])).toEqual({ fresh: ['/a/two.png', '/a/three.pdf'], duplicates: ['/a/one.png', '/a/two.png'] })
  expect(alreadyAttachedText(['one.png'])).toBe('one.png is already attached.')
  expect(alreadyAttachedText(['a', 'b'])).toBe('2 files are already attached.')
})

test('the same pasted bytes hash the same, whatever buffer holds them', () => {
  const bytes = new Uint8Array([1, 2, 3, 4])
  expect(contentHash(bytes)).toBe(contentHash(bytes.buffer))
  expect(contentHash(bytes)).not.toBe(contentHash(new Uint8Array([1, 2, 3, 5])))
})
