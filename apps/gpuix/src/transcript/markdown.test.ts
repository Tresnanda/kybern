import { describe, expect, test } from 'bun:test'
import { markdownParts, textChunks } from './markdown.tsx'

describe('bounded transcript Markdown', () => {
  test('expanded chunks preserve the entire source and bound each native node', () => {
    const source = Array.from({ length: 5000 }, (_, i) => `const value${i} = ${i};`).join('\n')
    const chunks = textChunks(source)
    expect(chunks.join('')).toBe(source)
    expect(chunks.every(chunk => chunk.length <= 8192 && (chunk.match(/\n/g)?.length ?? 0) <= 32)).toBe(true)
    expect(chunks.length).toBeGreaterThan(100)
  })
  test('long single lines and unicode stay exact across boundaries', () => {
    const source = 'x'.repeat(8191) + '🪐'.repeat(5000)
    const chunks = textChunks(source)
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
})
