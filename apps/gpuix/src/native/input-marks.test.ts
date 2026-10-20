import { describe, it, expect } from 'bun:test'
import { referenceDecorations, markdownInputDecorations } from './input-marks.ts'
const colors = { textSecondary: '#888888', accent: '#4477cc', buttonSecondary: '#eeeeee' }
describe('source-mode decoration adapters', () => {
  it('preserves UTF-16 token positions and rejects prefix/word collisions', () => {
    const text = '😀 @Computer @Computerish x@Computer @Computer.'
    const spans = referenceDecorations(text, [{ token: '@Computer', label: 'Computer' }], colors)
    expect(spans.every(s => s.style?.backgroundColor === undefined && s.style?.fontWeight === 500)).toBe(true)
    expect(spans.map(s => [s.start, text.slice(s.start, s.end)])).toEqual([[3, '@Computer'], [37, '@Computer']])
  })
  it('keeps code literal, ignores escaped marks, and makes task links atomic mid-sentence', () => {
    const task = '[ADE-1](kybern://task/00000000-0000-0000-0000-000000000001)'
    const text = `😀 **bold** *italic* \`**code**\` \\*literal* before ${task} after [web](https://example.com)`
    const spans = markdownInputDecorations(text, colors)
    expect(spans.filter(s => s.style?.fontWeight === 600).map(s => text.slice(s.start, s.end))).toEqual(['bold'])
    expect(spans.filter(s => s.style?.fontStyle === 'italic').map(s => text.slice(s.start, s.end))).toEqual(['italic'])
    expect(spans.filter(s => s.atomic).every(s => s.style?.backgroundColor === undefined)).toBe(true)
    expect(spans.find(s => s.style?.backgroundColor)?.style?.borderRadius).toBe(5)
    expect(spans.filter(s => s.atomic).map(s => text.slice(s.start, s.end))).toEqual([task])
    expect(spans.find(s => s.style?.underline)?.id).toContain('https://example.com')
  })
})
