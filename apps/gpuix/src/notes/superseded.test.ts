import { expect, test } from 'bun:test'
import { supersededBlocks } from './superseded.ts'

const place = (top: number) => ({ top, height: 24, ty: top + 2, lineHeight: 24 })
test('a struck claim followed by its superseded date is found at its place', () => {
  const blocks = [
    { id: 1, type: 'paragraph', content: [{ text: 'plain' }] },
    { id: 2, type: 'bullet', content: [{ text: 'old claim', marks: ['strike'] }, { text: ' (superseded 2026-10-25)' }] },
    { id: 3, type: 'bullet', content: [{ text: 'struck by hand', marks: ['strike'] }] },
    { id: 4, type: 'bullet', content: [{ text: 'not struck (superseded 2026-10-25)' }] },
  ] as never
  expect(supersededBlocks(blocks, [place(0), place(30), place(60), place(90)])).toEqual([{ index: 1, top: 30, height: 24, textTop: 32, lineHeight: 24, date: '2026-10-25' }])
})
test('a block with no place yet is skipped', () => {
  expect(supersededBlocks([{ id: 1, type: 'bullet', content: [{ text: 'x', marks: ['strike'] }, { text: ' (superseded 2026-10-25)' }] }] as never, [])).toEqual([])
})
