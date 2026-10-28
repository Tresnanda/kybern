import { describe, expect, it } from 'bun:test'
import { parseRichText, replaceRichText, RichHistory, richInputRule, richTableCellRange, serializeRichText, textEdit, toggleRichMark, updateRichText } from './rich-text.ts'
import { editTokenText, tokenDisplayOffset, tokenSourceOffset, tokenText } from '../composer/token-text.ts'
import { createMarkdownParser, parseMarkdownDocument } from '../shared/lib/markdownParser.ts'

const semantic = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(semantic)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'position').map(([key, item]) => [key, semantic(item)]))
}

describe('formatted native document', () => {
  it('edits visible characters and persists semantic nested marks, links and list prefixes', () => {
    const source = '# Heading\n\n**bold *both*** and [a link](https://example.com)\n- [ ] a task\n\n'
    const doc = parseRichText(source)
    expect(doc.text).toBe('Heading\n\nbold both and a link\n☐ a task')
    expect(serializeRichText(doc)).toBe(source)
    const at = doc.text.indexOf('both') + 2
    const edited = replaceRichText(doc, at, at, '😀')
    expect(serializeRichText(edited)).toBe('# Heading\n\n**bold *bo😀th*** and [a link](https://example.com)\n- [ ] a task\n\n')
  })
  it('preserves code literally and the original trailing paragraph separator', () => {
    const doc = parseRichText('```ts\nconst a = "**literal**"\n```\n\n')
    expect(doc.text).toBe('const a = "**literal**"')
    expect(serializeRichText(updateRichText(doc, 'const b = "**literal**"'))).toBe('```ts\nconst b = "**literal**"\n```\n\n')
    expect(parseRichText('paragraph\n\n').text).toBe('paragraph')
  })
  it('formats only the selection, removes partial marks without losing the rest', () => {
    const doc = parseRichText('plain words')
    const bold = toggleRichMark(doc, 6, 11, 'bold')
    expect(serializeRichText(bold)).toBe('plain **words**')
    const partial = toggleRichMark(bold, 7, 10, 'bold')
    expect(serializeRichText(partial)).toBe('plain **w**ord**s**')
    expect(serializeRichText(toggleRichMark(bold, 6, 11, 'bold'))).toBe('plain words')
  })
  it('keeps literal pasted Markdown safe and Unicode edit boundaries intact', () => {
    const doc = parseRichText('**abc**')
    expect(serializeRichText(replaceRichText(doc, 1, 2, '*😀*'))).toBe('**a\\*😀\\*c**')
    expect(textEdit('x😀z', 'x😃z')).toEqual({ start: 1, end: 3, text: '😃' })
    expect(textEdit('x😀z', 'x😀😃z')).toEqual({ start: 3, end: 3, text: '😃' })
  })
  it('applies Markdown input rules to the new range without exposing delimiters', () => {
    const rule = richInputRule(parseRichText('plain '), 6)
    expect(rule).toBeNull()
    const doc = updateRichText(parseRichText('plain '), 'plain **bold**')
    const next = richInputRule(doc, doc.text.length)!
    expect(next.doc.text).toBe('plain bold')
    expect(serializeRichText(next.doc)).toBe('plain **bold**')
    const heading = richInputRule(updateRichText(parseRichText(''), '# '), 2)!
    expect(heading.doc.text).toBe('')
    expect(serializeRichText(heading.doc)).toBe('# ')
  })
  it('restores formatting-only changes and selection, merges typing, drops redo on a new edit', () => {
    const doc = parseRichText('word'), history = new RichHistory({ doc, start: 0, end: 4 })
    const bold = toggleRichMark(doc, 0, 4, 'bold')
    history.record({ doc: bold, start: 0, end: 4 }, false, 100)
    history.record({ doc: updateRichText(bold, 'word1'), start: 5, end: 5 }, true, 200)
    history.record({ doc: updateRichText(bold, 'word12'), start: 6, end: 6 }, true, 300)
    expect(history.entries.length).toBe(3)
    expect(history.restore(-1)?.doc).toBe(bold)
    expect(history.restore(-1)).toEqual({ doc, start: 0, end: 4 })
    expect(history.restore(1)?.doc).toBe(bold)
    history.record({ doc, start: 4, end: 4 }, false, 400)
    expect(history.restore(1)).toBeNull()
    for (let i = 0; i < 300; i++) history.record({ doc, start: 0, end: 0 }, false)
    expect(history.entries.length).toBe(200)
  })
})

describe('lossless source and rendered Markdown semantics', () => {
  const fixtures = [
    '![alt](image.png)\n\nHello',
    '```ts\nconst x = `code`\n```\n\nHello',
    '[link](https://example.com "title")\n\nHello',
    'a `x``y` b\n\nHello',
    'a ``x`y`` b\n\nHello',
    '| a | b |\n| :- | -: |\n| x | **y** |\n\nHello',
    '> Quote **strong**\n> next line\n\nHello',
    '- one\n  - nested\n\nHello',
    '![asset](kybern://asset/00000000-0000-0000-0000-000000000001 "caption")\n\nHello',
    '[reference][id]\n\n[id]: https://example.com "title"\n\nHello',
    'a &amp; &#x1F600; &NotEqualTilde; \\*literal\\*\n\nHello',
  ]
  for (const source of fixtures) it(`preserves untouched syntax and rendering: ${source.split('\n')[0]}`, () => {
    const doc = parseRichText(source)
    expect(doc.text.endsWith('Hello')).toBe(true)
    const result = serializeRichText(updateRichText(doc, doc.text + '!'))
    expect(result).toBe(source + '!')
    const before = parseMarkdownDocument(source), after = parseMarkdownDocument(result)
    expect(semantic(after.children.slice(0, -1))).toEqual(semantic(before.children.slice(0, -1)))
    expect(semantic(after.children.at(-1))).toEqual({ type: 'paragraph', children: [{ type: 'text', value: 'Hello!' }] })
    const renderer = createMarkdownParser()
    const renderedBefore = renderer.parse(source).blocks.map(block => semantic(block.node))
    const renderedAfter = renderer.parse(result).blocks.map(block => semantic(block.node))
    expect(renderedAfter.slice(0, -1)).toEqual(renderedBefore.slice(0, -1))
  })
  it('exposes every block following a fence and preserves later edits', () => {
    const source = '```ts\nconst a = 1\n```\n\nHello\n\nLast paragraph'
    const doc = parseRichText(source)
    expect(doc.text).toBe('const a = 1\n\nHello\n\nLast paragraph')
    expect(serializeRichText(updateRichText(doc, doc.text.replace('Hello', 'Editable')))).toBe(source.replace('Hello', 'Editable'))
  })
  it('retains link titles while changing label text and crossing nested marks', () => {
    const doc = parseRichText('**before [label](https://example.com "title") after** and tail')
    const at = doc.text.indexOf('label')
    const edited = replaceRichText(doc, at, at + 5, 'new label')
    expect(serializeRichText(edited)).toContain('[new label](https://example.com "title")')
    const formatted = toggleRichMark(edited, 2, edited.text.length - 2, 'italic')
    const reopened = parseRichText(serializeRichText(formatted))
    expect(reopened.text).toBe(edited.text)
    expect(serializeRichText(formatted)).toContain('"title"')
    for (let i = 2; i < edited.text.length - 2; i++) if (/\S/.test(edited.text[i]!)) expect(reopened.marks.some(m => m.kind === 'italic' && m.start <= i && i < m.end)).toBe(true)
  })
  it('uses safe code delimiters when code content changes', () => {
    for (const source of ['a `x``y` b', 'a ``x`y`` b', '```ts\nx\n```']) {
      const doc = parseRichText(source), at = doc.text.indexOf('x')
      const next = replaceRichText(doc, at, at + 1, 'z`````')
      expect(parseRichText(serializeRichText(next)).text).toBe(doc.text.replace('x', 'z`````'))
      const code = parseMarkdownDocument(serializeRichText(next))
      expect(JSON.stringify(semantic(code))).toContain('z`````')
    }
  })
  it('keeps table structure, image metadata, and entities on edits inside their own block', () => {
    const table = parseRichText('| a | b |\n| - | - |\n| x | y |')
    const result = serializeRichText(updateRichText(table, table.text.replace('x', 'edited')))
    expect(parseMarkdownDocument(result).children[0]?.type).toBe('table')
    expect(result).toContain('| edited | y |')
    const image = parseRichText('![alt](image.png "title")')
    const changed = replaceRichText(image, 0, 3, 'updated')
    expect(semantic(parseMarkdownDocument(serializeRichText(changed)).children[0])).toEqual({ type: 'paragraph', children: [{ type: 'image', title: 'title', url: 'image.png', alt: 'updated' }] })
    const entity = parseRichText('a &#x1F600; &amp; b')
    expect(parseRichText(serializeRichText(updateRichText(entity, 'a 😃 & b'))).text).toBe('a 😃 & b')
  })
  it('preserves untouched entity and escape spelling within an edited text leaf', () => {
    const source = String.raw`Left &amp; &#x1F600; &NotEqualTilde; \*literal\* right`
    const doc = parseRichText(source)
    const next = updateRichText(doc, doc.text + '!')
    expect(serializeRichText(next)).toBe(source + '!')
    expect(parseRichText(serializeRichText(next)).text).toBe(doc.text + '!')
  })

  it('uses table phrasing ranges rather than separator-inclusive cell positions', () => {
    const source = '| First | Second |\n| - | - |\n| cell | **value** |\n|  | \\| |'
    const table = parseRichText(source).tree!.children![0]!
    const values = table.children!.flatMap(row => row.children!.map(cell => {
      const range = richTableCellRange(source, cell)
      return source.slice(range.start, range.end)
    }))
    expect(values).toEqual(['First', 'Second', 'cell', '**value**', '', '\\|'])
    const cell = table.children![1]!.children![0]!, range = richTableCellRange(source, cell)
    const changed = source.slice(0, range.start) + 'cellx' + source.slice(range.end)
    expect(changed).toBe(source.replace('| cell |', '| cellx |'))
    expect(parseRichText(changed).tree!.children![0]!.children![1]!.children).toHaveLength(2)
  })

  it('resolves references across virtual block boundaries without copying definitions into edited source', () => {
    const context = '[id]: https://example.com "title"\n[image]: image.png "caption"'
    const doc = parseRichText('[label][id] and ![alt][image]', context)
    expect(doc.text).toBe('label and alt')
    expect(doc.marks.find(m => m.kind === 'link')?.href).toBe('https://example.com')
    expect(doc.marks.some(m => m.kind === 'image')).toBe(true)
    const changed = replaceRichText(doc, 0, 1, 'L')
    expect(serializeRichText(changed)).toBe('[Label][id] and ![alt][image]')
    expect(changed.text).toBe('Label and alt')
    expect(serializeRichText(changed)).not.toContain('[id]:')
  })
  it('preserves typed trailing spaces and line breaks in the visible editing buffer', () => {
    let doc = parseRichText('Hello\n\n')
    for (const value of ['Hello ', 'Hello \n', 'Hello \n\n', 'Hello \n\nnew']) {
      doc = updateRichText(doc, value)
      expect(doc.text).toBe(value)
    }
    expect(parseRichText(serializeRichText(doc)).text).toContain('new')
  })
  it('keeps text exact across every selection spanning nested marks, titles, and paragraph boundaries', () => {
    for (const source of ['**bold** and *italic*', 'one **two *three* four** end', '**before [label](https://example.com "title") after** and tail', '**one**\n\n*two*']) {
      const doc = parseRichText(source)
      for (let start = 0; start < doc.text.length; start++) for (let end = start + 1; end <= doc.text.length; end++) {
        expect(replaceRichText(doc, start, end, 'X').text).toBe(doc.text.slice(0, start) + 'X' + doc.text.slice(end))
        for (const kind of ['bold', 'italic', 'strike', 'code'] as const) {
          const changed = toggleRichMark(doc, start, end, kind)
          expect(parseRichText(serializeRichText(changed)).text).toBe(doc.text)
        }
      }
    }
  }, 30000)
})

describe('inline token projection', () => {
  const references = [{ token: '@"A long note title"', label: 'A long note title' }, { token: '@Computer', label: 'Computer' }]
  it('uses visible labels inline and maps raw UTF-16 ranges in both directions', () => {
    const doc = tokenText('😀 @"A long note title" and @Computer.', references)
    expect(doc.text).toBe('😀 A long note title and Computer.')
    for (const span of doc.spans) {
      expect(tokenSourceOffset(doc, span.start)).toBe(span.sourceStart)
      expect(tokenSourceOffset(doc, span.end)).toBe(span.sourceEnd)
      expect(tokenDisplayOffset(doc, span.sourceStart)).toBe(span.start)
      expect(tokenDisplayOffset(doc, span.sourceEnd)).toBe(span.end)
      expect(tokenSourceOffset(doc, span.start + 1, true)).toBe(span.sourceEnd)
    }
  })
  it('keeps identical plain labels distinct from known references; deletes and replaces complete chips', () => {
    const doc = tokenText('Computer @Computer and x@Computer @Computerish', references)
    expect(doc.spans.length).toBe(1)
    expect(editTokenText(doc, 'Computer  and x@Computer @Computerish').value).toBe('Computer  and x@Computer @Computerish')
    expect(editTokenText(doc, 'Computer replacement and x@Computer @Computerish').value).toBe('Computer replacement and x@Computer @Computerish')
    const before = tokenText('😀 @Computer', references)
    expect(editTokenText(before, '😃 Computer').value).toBe('😃 @Computer')
  })
})
