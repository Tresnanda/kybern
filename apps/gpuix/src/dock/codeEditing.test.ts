import { expect, test } from 'bun:test'
import { codeKeyEdit, indentUnit, lineOf, type CodeEdit } from './codeEditing.ts'

const apply = (text: string, edit: CodeEdit | null) => edit && text.slice(0, edit.start) + edit.text + text.slice(edit.end)
const at = (text: string) => { const caret = text.indexOf('|'); return { text: text.replace('|', ''), selection: { start: caret, end: caret } } }

test('the indent unit follows the file', () => {
  expect(indentUnit('a\n\tb\n\tc\n')).toBe('\t')
  expect(indentUnit('a\n    b\n        c\n')).toBe('    ')
  expect(indentUnit('a\n  b\n    c\n')).toBe('  ')
  expect(indentUnit('no indent')).toBe('  ')
})

test('Enter keeps the indent and opens a block after a bracket', () => {
  const plain = at('  const a = 1|')
  expect(apply(plain.text, codeKeyEdit(plain.text, plain.selection, 'enter', undefined, false, '  '))).toBe('  const a = 1\n  ')
  const open = at('  if (x) {|')
  expect(apply(open.text, codeKeyEdit(open.text, open.selection, 'enter', undefined, false, '  '))).toBe('  if (x) {\n    ')
  const split = at('f({|})')
  const edit = codeKeyEdit(split.text, split.selection, 'enter', undefined, false, '  ')!
  expect(apply(split.text, edit)).toBe('f({\n  \n})')
  expect(edit.caret).toBe('f({\n  '.length)
  const python = at('def f():|')
  expect(apply(python.text, codeKeyEdit(python.text, python.selection, 'enter', undefined, false, '    ', 'a.py'))).toBe('def f():\n    ')
  // A caret inside the indent does not double it.
  const inside = at('  |  x')
  expect(apply(inside.text, codeKeyEdit(inside.text, inside.selection, 'enter', undefined, false, '  '))).toBe('  \n    x')
})

test('Tab inserts the unit; on several lines it indents and Shift-Tab outdents', () => {
  const caret = at('a|b')
  expect(apply(caret.text, codeKeyEdit(caret.text, caret.selection, 'tab', undefined, false, '  '))).toBe('a  b')
  const text = 'one\ntwo\n\nthree'
  const all = { start: 0, end: text.length }
  const indented = codeKeyEdit(text, all, 'tab', undefined, false, '  ')!
  expect(apply(text, indented)).toBe('  one\n  two\n\n  three')
  const back = apply(text, indented)!
  expect(apply(back, codeKeyEdit(back, { start: 0, end: back.length }, 'tab', undefined, true, '  '))).toBe(text)
  // Shift-Tab with nothing to remove leaves the key to the editor.
  expect(codeKeyEdit('x', { start: 0, end: 0 }, 'tab', undefined, true, '  ')).toBeNull()
  // A selection ending at a line start leaves that line alone.
  expect(apply('a\nb', codeKeyEdit('a\nb', { start: 0, end: 2 }, 'tab', undefined, false, '\t'))).toBe('\ta\nb')
})

test('brackets and quotes pair, overtype and delete as a pair', () => {
  const empty = at('f|')
  expect(apply(empty.text, codeKeyEdit(empty.text, empty.selection, '9', '(', true, '  '))).toBe('f()')
  const close = at('f(|)')
  expect(codeKeyEdit(close.text, close.selection, '0', ')', true, '  ')).toEqual({ start: 2, end: 2, text: '', caret: 3 })
  expect(apply(close.text, codeKeyEdit(close.text, close.selection, 'backspace', undefined, false, '  '))).toBe('f')
  // No pairing before a word, or a quote after a letter (it's).
  const word = at('|x')
  expect(codeKeyEdit(word.text, word.selection, '9', '(', true, '  ')).toBeNull()
  const apostrophe = at('it|')
  expect(codeKeyEdit(apostrophe.text, apostrophe.selection, "'", "'", false, '  ')).toBeNull()
  // A selection is wrapped and stays selected.
  const wrapped = codeKeyEdit('a b', { start: 2, end: 3 }, "'", '"', true, '  ')!
  expect(apply('a b', wrapped)).toBe('a "b"')
  expect([wrapped.caret, wrapped.caretEnd]).toEqual([3, 4])
})

test('lines are 1-based', () => {
  expect(lineOf('a\nb\nc', 0)).toBe(1)
  expect(lineOf('a\nb\nc', 2)).toBe(2)
  expect(lineOf('a\nb\nc', 5)).toBe(3)
})
