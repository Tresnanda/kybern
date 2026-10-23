import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { alreadyAttachedText, contentHash, fileKey, hasToken, newFiles, removalEdit, standingTokens, tokenRanges, withoutTrigger } from './attached.ts'

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
  const attached = [{ path: '/a/one.png' }, { path: 'data:image/png;base64,AAAA' }, {}] as { path?: string }[]
  expect(newFiles(attached, ['/a/one.png', '/a/two.png', '/a/two.png', '/a/three.pdf'])).toEqual({ fresh: ['/a/two.png', '/a/three.pdf'], duplicates: ['/a/one.png', '/a/two.png'] })
  expect(alreadyAttachedText(['one.png'])).toBe('one.png is already attached.')
  expect(alreadyAttachedText(['a', 'b'])).toBe('2 files are already attached.')
})

test('the same pasted bytes hash the same, whatever buffer holds them', () => {
  const bytes = new Uint8Array([1, 2, 3, 4])
  expect(contentHash(bytes)).toBe(contentHash(bytes.buffer))
  expect(contentHash(bytes)).not.toBe(contentHash(new Uint8Array([1, 2, 3, 5])))
})

// Review 2026-10-23: the marks came from a per-token scan that disagreed with the editor's chips, and a pick-again removal
// pruned the chip's reference, so an undo brought the token back as plain text with no check.
test('a mark and a removal see the chips the editor draws: a longer chip that starts with a token is not that token', () => {
  const known = ['@a.ts', '@a.ts.bak', '@image1', '@image10']
  expect(tokenRanges('see @a.ts.bak and @a.ts.', '@a.ts', known)).toEqual([[18, 23]])
  expect(standingTokens('see @a.ts.bak and @image10', known)).toEqual(new Set(['@a.ts.bak', '@image10']))
  // Without the longer token known, `@a.ts` followed by `.` is a chip, exactly as `tokenText` draws it.
  expect(standingTokens('see @a.ts.bak', ['@a.ts'])).toEqual(new Set(['@a.ts']))
  // The trigger being typed never counts, even when it is already a whole token.
  expect(standingTokens('$review', ['$review'], [0, 7]).size).toBe(0)
  // Removing one never touches its neighbour, adjacent or sharing a prefix.
  const text = '@a.ts.bak @a.ts @image10 @image1'
  expect(apply(text, removalEdit(text, '@a.ts', null, known))).toBe('@a.ts.bak @image10 @image1')
  expect(apply(text, removalEdit(text, '@image1', null, known))).toBe('@a.ts.bak @a.ts @image10')
  expect(removalEdit('@a.ts.bak', '@a.ts', null, known)).toBeNull()
  // Emoji and other astral text around a chip are kept whole.
  expect(apply('😀 @x 👍🏽', removalEdit('😀 @x 👍🏽', '@x', null))).toBe('😀 👍🏽')
  expect(hasToken('👍🏽@x', '@x')).toBe(false)
})

test('one file spelled differently (relative, ./, doubled or trailing slashes, a symlink) is attached once', () => {
  const dir = mkdtempSync(`${tmpdir()}/attached-`)
  try {
    mkdirSync(`${dir}/sub`)
    writeFileSync(`${dir}/sub/a.png`, 'x')
    writeFileSync(`${dir}/sub/b.png`, 'y')
    symlinkSync(`${dir}/sub`, `${dir}/link`)
    const key = fileKey(`${dir}/sub/a.png`)
    for (const spelling of [`${dir}/sub/./a.png`, `${dir}//sub/a.png`, `${dir}/sub/../sub/a.png`, `${dir}/link/a.png`]) expect(fileKey(spelling)).toBe(key)
    // A relative path is read from the working directory, as the upload reads it.
    expect(fileKey('./x/../y.png')).toBe(fileKey(`${process.cwd()}/y.png`))
    expect(fileKey('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA')
    const { fresh, duplicates } = newFiles([{ path: `${dir}/sub/a.png` }], [`${dir}/link/./a.png`, `${dir}/sub/b.png`, `${dir}/link/b.png`])
    expect(fresh).toEqual([`${dir}/sub/b.png`])
    expect(duplicates).toEqual([`${dir}/link/./a.png`, `${dir}/link/b.png`])
    // Two different files that share a name are both attached.
    expect(newFiles([{ path: `${dir}/sub/a.png` }], [`${dir}/a.png`]).fresh).toEqual([`${dir}/a.png`])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
