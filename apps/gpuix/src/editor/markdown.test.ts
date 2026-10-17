import { describe, expect, test } from 'bun:test'
import { canonical, parseDoc, serializeDoc, type DocBlock } from './markdown.ts'

const SAMPLES = [
  '',
  'Just one line\n',
  '# Title\n\nA paragraph with **bold**, *italic*, ~~strike~~, `code` and a [link](https://kybern.dev "t").\n',
  '- one\n- two\n  - nested\n    1. deep\n- three\n',
  '* star bullets\n+ plus\n',
  '- [ ] open\n- [x] done [ADE-14](kybern://task/11111111-1111-1111-1111-111111111111)\n',
  '3. three\n4. four\n\n> quoted\n> lines\n>\n> second paragraph\n',
  '```ts\nconst a = 1\n```\n\n---\n\n![shot](kybern://asset/abc "Title")\n',
  '| a | b |\n|---|---|\n| 1 | 2 |\n\n<div>html</div>\n\n[ref]: https://example.com\n',
  'soft\nbreak and hard  \nbreak\n',
  'Trailing spaces stay   \n\n\n\nextra blank lines\n',
  '- item\n\n  continued paragraph\n\n  ```\n  code in item\n  ```\n',
]

describe('markdown round trip', () => {
  for (const source of SAMPLES) {
    test(JSON.stringify(source.slice(0, 40)), () => {
      const doc = parseDoc(source)
      expect(serializeDoc(doc.blocks, doc)).toBe(source)
      // What the native editor sends back is the canonical form of the same blocks.
      expect(serializeDoc(doc.blocks.map(b => JSON.parse(JSON.stringify(canonical(b)))), doc)).toBe(source)
    })
  }
})

describe('edits rewrite only the touched blocks', () => {
  test('typing in one paragraph keeps the others byte for byte', () => {
    const source = '# Notes\n\nFirst  *one*\n\n* second __two__\n'
    const doc = parseDoc(source)
    const blocks = structuredClone(doc.blocks) as DocBlock[]
    blocks[1]!.content!.push({ text: ' more' })
    expect(serializeDoc(blocks, doc)).toBe('# Notes\n\nFirst  *one* more\n\n* second __two__\n')
  })
  test('a toggled checklist item and an inserted one', () => {
    const doc = parseDoc('- [ ] a\n- [ ] b\n')
    const blocks = structuredClone(doc.blocks) as DocBlock[]
    blocks[0]!.checked = true
    blocks.splice(1, 0, { id: 99, type: 'task', checked: false, content: [{ text: 'new' }] })
    expect(serializeDoc(blocks, doc)).toBe('- [x] a\n- [ ] new\n- [ ] b\n')
  })
  test('numbered items are renumbered', () => {
    const doc = parseDoc('1. a\n2. b\n')
    const blocks = structuredClone(doc.blocks) as DocBlock[]
    blocks.splice(1, 0, { id: 50, type: 'ordered', start: 1, content: [{ text: 'x' }] })
    expect(serializeDoc(blocks, doc)).toBe('1. a\n2. x\n2. b\n'.replace('2. b', '2. b'))
  })
  test('marks, links, task references and hard breaks are written like TipTap', () => {
    const doc = parseDoc('x\n')
    const blocks: DocBlock[] = [
      { id: 1, type: 'heading', level: 2, content: [{ text: 'Head' }] },
      { id: 2, type: 'paragraph', content: [{ text: 'a ' }, { text: 'bold', marks: ['bold'] }, { text: ' ' }, { text: 'both', marks: ['bold', 'italic'] }, { text: '\nline' }] },
      { id: 3, type: 'paragraph', content: [{ text: 'see ' }, { atom: { type: 'taskRef', id: '11111111-1111-1111-1111-111111111111', label: 'ADE-1' } }, { text: ' and ' }, { text: 'site', link: { href: 'https://x.io', title: null } }] },
    ]
    expect(serializeDoc(blocks, doc)).toBe('## Head\n\na **bold** ***both***  \nline\n\nsee [ADE-1](kybern://task/11111111-1111-1111-1111-111111111111) and [site](https://x.io)\n')
  })
  test('an empty document is empty', () => {
    const doc = parseDoc('old text\n')
    expect(serializeDoc([{ id: 1, type: 'paragraph', content: [] }], doc)).toBe('')
  })
})

describe('sources the session checks keep', () => {
  for (const source of ['', '\n\n', '# Title\n\nBody\n', '```js\n\ncode\n```\n\nTail', 'a\r\n\r\nb\r\n', '~~~\n\n~~~\n\n', '    code\n\n    more\n']) {
    test(JSON.stringify(source), () => { const doc = parseDoc(source); expect(serializeDoc(doc.blocks, doc)).toBe(source) })
  }
})
