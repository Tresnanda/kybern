import { expect, test } from 'bun:test'
import { VT } from './vt.ts'
import { selectedText } from './selection.ts'
test('selection copies only the chosen cells across rows in either drag direction', () => {
  const vt = new VT(20, 3); vt.write('first line\r\nsecond line')
  const anchor = { line: vt.screen[0]!.id, column: 6 }, head = { line: vt.screen[1]!.id, column: 6 }
  expect(selectedText(vt.lines(), { anchor, head }, 20)).toBe('line\nsecond')
  expect(selectedText(vt.lines(), { anchor: head, head: anchor }, 20)).toBe('line\nsecond')
})
test('a selection beginning inside a wide glyph preserves its complete character', () => {
  const vt = new VT(20, 2); vt.write('ab界cd')
  expect(selectedText(vt.lines(), { anchor: { line: vt.screen[0]!.id, column: 3 }, head: { line: vt.screen[0]!.id, column: 5 } }, 20)).toBe('界c')
})
