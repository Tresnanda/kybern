import { expect, test } from 'bun:test'
import { diffFileIcons } from '../native/diff-file-icons.ts'
import { tinted } from '../transcript/kit.tsx'
test('file glyph fills and outline strokes both take the chip tint in either theme', () => {
  for (const color of ['#93bbff', '#215ab8']) {
    const react = tinted(diffFileIcons.react!, color)
    expect(react).toContain(`fill="${color}"`)
    expect(react).not.toContain('black')
    const multi = tinted('<svg fill="none"><path fill="#123456" stroke="black"/><path fill="currentColor"/></svg>', color)
    expect(multi).toContain('fill="none"')
    expect(multi.match(new RegExp(color, 'g'))).toHaveLength(3)
  }
})
