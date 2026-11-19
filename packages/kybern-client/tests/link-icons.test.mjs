import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyLink, markdownLinks, linkStateColor } from '../src/linkIcons.ts'
test('reply link classification preserves labels and separates GitHub targets', () => {
  assert.equal(classifyLink('https://github.com/a/b/issues/275#issuecomment-1').kind, 'issue')
  assert.equal(classifyLink('https://github.com/a/b/pull/278/files').kind, 'pull')
  for (const path of ['a/b', 'a/b/commit/abc', 'a/b/actions/runs/1']) assert.equal(classifyLink('https://github.com/' + path).kind, 'github')
  assert.equal(classifyLink('https://github.com.evil.test/a/b/issues/1').kind, 'web')
  assert.equal(classifyLink('./report.md').kind, 'file')
  assert.equal(classifyLink('file:///tmp/report.pdf').kind, 'file')
  assert.equal(classifyLink('javascript:alert(1)').kind, 'none')
  assert.deepEqual(markdownLinks('[#277](https://github.com/a/b/issues/277)'), ['https://github.com/a/b/issues/277'])
  assert.equal(linkStateColor('draft'), '#848d97')
})
test('a single-ink site icon gets a plate only where it is hard to see, and dark mode prefers the dark icon', async () => {
  const { replyFavicon, opaqueColor, contrastRatio, relativeLuminance } = await import('../src/linkIcons.ts')
  const dark = '#181818', light = '#ffffff'
  const darkPlates = [opaqueColor('rgba(252, 252, 252, 0.58)', dark), '#fcfcfc'], lightPlates = [opaqueColor('rgba(13, 13, 13, 0.598)', light), '#0d0d0d']
  const black = { favicon: 'data:black', faviconLuminance: 0, faviconInk: 'dark' }
  const white = { favicon: 'data:white', faviconLuminance: 1, faviconInk: 'light' }
  // A black transparent logo: a light plate in dark mode, nothing in light mode.
  const onDark = replyFavicon(black, dark, darkPlates)
  assert.equal(onDark.src, 'data:black')
  assert.equal(onDark.plate, darkPlates[0])
  assert.ok(contrastRatio(0, relativeLuminance(onDark.plate)) >= 3)
  assert.deepEqual(replyFavicon(black, light, lightPlates), { src: 'data:black' })
  // A white one: the reverse.
  assert.deepEqual(replyFavicon(white, dark, darkPlates), { src: 'data:white' })
  assert.equal(replyFavicon(white, light, lightPlates).plate, lightPlates[0])
  // Colourful, two-ink and unmeasured icons are left alone everywhere.
  for (const ink of ['color', 'mixed']) for (const [bg, plates] of [[dark, darkPlates], [light, lightPlates]]) assert.equal(replyFavicon({ favicon: 'x', faviconLuminance: 0.02, faviconInk: ink }, bg, plates).plate, undefined)
  assert.deepEqual(replyFavicon({ favicon: 'x' }, dark, darkPlates), { src: 'x' })
  // A mid-grey icon is readable on both.
  assert.equal(replyFavicon({ favicon: 'x', faviconLuminance: 0.2, faviconInk: 'light' }, dark, darkPlates).plate, undefined)
  // The site's own dark icon is used on a dark background, and judged by its own measurement.
  const both = { ...black, faviconDark: 'data:dark', faviconDarkLuminance: 1, faviconDarkInk: 'light' }
  assert.deepEqual(replyFavicon(both, dark, darkPlates), { src: 'data:dark' })
  assert.deepEqual(replyFavicon(both, light, lightPlates), { src: 'data:black' })
  // A quiet plate that would not reach 3:1 gives way to the next one.
  assert.equal(replyFavicon({ favicon: 'x', faviconLuminance: 0.05, faviconInk: 'dark' }, dark, ['#3a3a3a', '#fcfcfc']).plate, '#fcfcfc')
  assert.equal(replyFavicon({}, dark, darkPlates), undefined)
  assert.equal(opaqueColor('#ff000080', '#ffffff'), '#ff7f7f')
  assert.equal(opaqueColor('rgb(1 2 3)', '#ffffff'), '#010203')
})
