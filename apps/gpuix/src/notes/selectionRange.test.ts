import { expect, test } from 'bun:test'
import { markRange } from './selectionRange.ts'

test('format only the UTF-16 selection and toggle surrounding marks without changing adjacent text', () => {
  const source = 'Before 😀é after'
  const edit = markRange(source, 7, 10, '**')
  const marked = source.slice(0, edit.start) + edit.text + source.slice(edit.end)
  expect(marked).toBe('Before **😀é** after')
  const undo = markRange(marked, edit.selectionStart, edit.selectionEnd, '**')
  expect(marked.slice(0, undo.start) + undo.text + marked.slice(undo.end)).toBe(source)
})

test('unwrap marks selected with text and insert paired marks at a caret', () => {
  expect(markRange('a **bold** z', 2, 10, '**').text).toBe('bold')
  expect(markRange('ab', 1, 1, '*')).toEqual({ start: 1, end: 1, text: '**', selectionStart: 2, selectionEnd: 2 })
})
