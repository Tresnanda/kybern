import { expect, test } from 'bun:test'
import { CHIP_FONT_SIZE, CHIP_ICON_SIZE, CHIP_PAD, ICON_PAD, tokenText } from './token-text.ts'
import { CHIP_ICON_GAP, FONTS } from '../platform/fonts.ts'

test('a chip with an icon leads with the pad, one without does not', () => {
  const doc = tokenText('@a.ts and @b', [{ token: '@a.ts', label: 'a.ts', icon: '<svg/>' }, { token: '@b', label: 'b' }])
  expect(doc.text).toBe(`${ICON_PAD}a.ts and b`)
  expect(doc.spans.map(span => [span.start, span.end])).toEqual([[0, ICON_PAD.length + 4], [ICON_PAD.length + 9, ICON_PAD.length + 10]])
})

test('the pad reserves the room the icon needs on this OS', () => {
  expect(ICON_PAD.trim()).toBe('')
  expect(ICON_PAD.length).toBeGreaterThanOrEqual(2)
  // Off macOS the pad is the UI face's own spaces, so its width does not depend on the code face resolving.
  if (FONTS.uiSpaceAdvance !== null) {
    expect(CHIP_PAD.ui).toBe(true)
    expect(ICON_PAD.length * FONTS.uiSpaceAdvance * CHIP_FONT_SIZE).toBeGreaterThanOrEqual(CHIP_ICON_SIZE + CHIP_ICON_GAP)
  } else expect(ICON_PAD).toBe('  ')
})
