import { expect, test } from 'bun:test'
import { revealBoundary } from './reveal.ts'
test('word reveal stays monotonic, preserves surrogate pairs, and reaches exact final text', () => {
  for (const text of ['One pleasant sentence.', '🌿🤝🌱 unicode', 'averylongunbrokentokenwithoutspaces', '漢字仮名交じり文']) {
    let previous = 0
    for (let i = 0; i <= text.length; i++) {
      const end = revealBoundary(text, i)
      expect(end).toBeGreaterThanOrEqual(previous)
      expect(end).toBeLessThanOrEqual(i)
      expect(end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]!)).toBe(false)
      previous = end
    }
    expect(text.slice(0, previous)).toBe(text)
  }
  expect(revealBoundary('One pleasant sentence.', 8)).toBe(4)
})
