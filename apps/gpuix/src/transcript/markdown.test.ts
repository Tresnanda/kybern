import { describe, expect, test } from 'bun:test'
import { lineChunks, markdownParts, splitImages, textChunks } from './markdown.tsx'

describe('bounded transcript Markdown', () => {
  test('expanded code chunks preserve the entire source and bound each native node', () => {
    const source = Array.from({ length: 5000 }, (_, i) => `const value${i} = ${i};`).join('\n')
    const chunks = lineChunks(source)
    expect(chunks.join('')).toBe(source)
    expect(chunks.every(chunk => chunk.length <= 8192 && (chunk.match(/\n/g)?.length ?? 0) <= 32)).toBe(true)
    expect(chunks.length).toBeGreaterThan(100)
  })
  test('long single lines and unicode stay exact across boundaries', () => {
    const source = 'x'.repeat(8191) + '🪐'.repeat(5000)
    const chunks = lineChunks(source)
    expect(chunks.join('')).toBe(source)
    expect(chunks.every(chunk => chunk.length <= 8193 && !/[\uD800-\uDBFF]$/.test(chunk))).toBe(true)
  })
  test('longer fences preserve shorter fences inside source', () => {
    const parts = markdownParts('Before\n\n````markdown\n```python\nprint(1)\n```\n````\n\nAfter')
    expect(parts.map(part => part.kind)).toEqual(['prose', 'code', 'prose'])
    expect(parts[1]?.text).toBe('```python\nprint(1)\n```')
    expect(parts[1]?.language).toBe('markdown')
  })
  test('native tables and inline code remain whole in a normal prose block', () => {
    const source = '| Prime | Next |\n| --- | --- |\n| 2 | 3 |\n\nUse `x`.'
    expect(markdownParts(source)).toEqual([{ kind: 'prose', key: '0', text: source, language: undefined }])
    expect(markdownParts(source)).toBe(markdownParts(source))
  })

  // The orchestrator's reply of 2026-10-20 22:18 (thread "Motion phase", event 1845678): its table header was line 32,
  // so the old 32-line split left `|---|---|` and every row as one paragraph of pipes.
  const reply = [
    'The composer tray work is done and merged.', '',
    ...Array.from({ length: 11 }, (_, i) => [`**Point ${i}:** detail ${i}.`, '']).flat(),
    '- one', '- two', '', 'Text before the table.', '',
    '**Still running:**', '',
    '| Agent | Job |', '|---|---|',
    '| Opus · GPUIX native | Menu start delay, hover colour fades, height animations |',
    '| Sonnet · GPUIX dock and overlays | Package 3 |',
    '', 'After they finish: an Opus review of the whole branch, then a PR.',
  ].join('\n')
  test('a table right after a paragraph stays in one piece with its header and delimiter', () => {
    expect(reply.split('\n').indexOf('| Agent | Job |')).toBe(31)
    // The old split (now `lineChunks`, for code) cut right after the header.
    expect(lineChunks(reply)[1]!.startsWith('|---|---|')).toBe(true)
    const chunks = textChunks(reply)
    expect(chunks.join('')).toBe(reply)
    const table = chunks.find(chunk => chunk.includes('| Agent | Job |'))!
    expect(table).toContain('| Agent | Job |\n|---|---|\n| Opus')
    expect(chunks.every(chunk => !chunk.startsWith('|---'))).toBe(true)
  })
  test('pieces split only where a new top-level block starts, and stay bounded', () => {
    const blocks: string[] = []
    for (let i = 0; blocks.join('\n\n').length < 40000; i++) {
      if (i % 7 === 3) blocks.push(`| A | B |\n|---|---|\n${Array.from({ length: 12 }, (_, r) => `| row ${r} | ${i} |`).join('\n')}`)
      else if (i % 5 === 1) blocks.push(Array.from({ length: 6 }, (_, r) => `- item ${r}\n  continuation`).join('\n'))
      else blocks.push(`Paragraph ${i}: ${'words '.repeat(60)}`)
    }
    const long = blocks.join('\n\n')
    const chunks = textChunks(long)
    expect(chunks.join('')).toBe(long)
    expect(chunks.length).toBeGreaterThan(10)
    expect(chunks.slice(1).every(chunk => /^\S/.test(chunk) && !chunk.startsWith('|---'))).toBe(true)
    expect(chunks.every(chunk => chunk.split('\n').length <= 40)).toBe(true)
    // Streaming: every prefix cuts its earlier pieces exactly where the whole reply does.
    for (let end = 1; end <= long.length; end += 131) {
      const prefix = textChunks(long.slice(0, end))
      expect(prefix.slice(0, -1)).toEqual(chunks.slice(0, prefix.length - 1))
    }
  })
  test('a table arriving across deltas is never split from its header', () => {
    for (let end = reply.indexOf('| Agent'); end <= reply.length; end++) {
      const chunks = textChunks(reply.slice(0, end))
      expect(chunks.some(chunk => /(^|\n)\|---/.test(chunk) && !chunk.includes('| Agent | Job |\n|---'))).toBe(false)
    }
  })
  test('only a pathological table splits inside, repeating its header so the rest is still a table', () => {
    const huge = `Intro\n\n| A | B |\n|---|---|\n${Array.from({ length: 700 }, (_, r) => `| r${r} | v |`).join('\n')}\n\nAfter`
    const chunks = textChunks(huge)
    expect(chunks.length).toBeGreaterThan(2)
    expect(chunks.filter(chunk => chunk.startsWith('| A | B |\n|---|---|\n')).length).toBe(chunks.length - 2)
    expect(chunks.join('').length).toBe(huge.length + (chunks.length - 3) * '| A | B |\n|---|---|\n'.length)
  })

  // Thread 01a159cb… (ridenation-web), event 1851999: both rendered as blue links, and clicking said the folder was hidden.
  test('images on their own lines become image parts, with captions and sources as written', () => {
    const reply = 'Before.\n\n![Booking form, desktop](.screenshots/times/trip-1280.png)\n![Booking form, Indonesian, 7 h late](.screenshots/times/trip-390-id-extra-day.png)\n\nAfter.'
    expect(markdownParts(reply).map(p => [p.kind, p.text, p.alt])).toEqual([
      ['prose', 'Before.\n', undefined],
      ['image', '.screenshots/times/trip-1280.png', 'Booking form, desktop'],
      ['image', '.screenshots/times/trip-390-id-extra-day.png', 'Booking form, Indonesian, 7 h late'],
      ['prose', '\nAfter.', undefined],
    ])
    expect(splitImages('![a](./shots/one.png) ![b](<shots/two words ä.png> "title")')).toEqual([
      { kind: 'image', alt: 'a', source: './shots/one.png' },
      { kind: 'image', alt: 'b', source: 'shots/two words ä.png' },
    ])
  })
  test('inline images and images inside fences stay in the text', () => {
    const inline = 'See ![shot](a.png) here.'
    expect(splitImages(inline)).toEqual([{ kind: 'text', text: inline }])
    const fenced = '- item\n\n  ```md\n![shot](a.png)\n  ```'
    expect(splitImages(fenced)).toEqual([{ kind: 'text', text: fenced }])
  })
})
