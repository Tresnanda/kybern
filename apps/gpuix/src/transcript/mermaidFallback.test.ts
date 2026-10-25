import { expect, test } from 'bun:test'
import { diagramLabel, diagramNote } from './mermaidFallback.ts'

test('a diagram that cannot be drawn on this platform keeps its source and says why', () => {
  expect(diagramLabel('unsupported')).toBe('Mermaid diagram')
  expect(diagramNote('unsupported')).toContain("can't be drawn on this platform")
  expect(diagramNote('unsupported')).toContain('Copy the source')
})
test('the existing loading and failed states keep their words', () => {
  expect(diagramLabel('loading')).toBe('Rendering diagram…')
  expect(diagramLabel('failed')).toBe('Mermaid source')
  expect(diagramNote('failed')).toBe('Preview unavailable. You can still copy the source.')
  expect(diagramNote('loading')).toBeNull()
  expect(diagramNote('ready')).toBeNull()
})
