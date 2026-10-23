// Its own process folder: `imageFiles.ts` reads KYBERN_CLIENT_CONFIG_DIR once.
import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gradientPng } from '../../visual/fixture.ts'

const dir = mkdtempSync(path.join(tmpdir(), 'kybern-image-files-'))
process.env.KYBERN_CLIENT_CONFIG_DIR = dir
const { imageFiles, storeImageBytes } = await import('./imageFiles.ts')
/** A PNG's pixel width, from its header. */
const width = (file: string) => readFileSync(file).readUInt32BE(16)

test('a data URL becomes the original file and a copy at most maxPx wide', async () => {
  const png = gradientPng(1600, 900)
  const files = (await imageFiles(`data:image/png;base64,${Buffer.from(png).toString('base64')}`, 560, 1600))!
  expect(files.full.startsWith(path.join(dir, 'image-cache'))).toBe(true)
  expect(width(files.full)).toBe(1600)
  // The narrow copy is made with `sips` (macOS); elsewhere the original is shown inline.
  const mac = process.platform === 'darwin'
  expect(width(files.inline)).toBe(mac ? 560 : 1600)
  // The same bytes again: one original, one copy, no new work.
  expect(await imageFiles(`data:image/png;base64,${Buffer.from(png).toString('base64')}`, 560, 1600)).toEqual(files)
  expect(readdirSync(path.join(dir, 'image-cache')).filter(f => !f.endsWith('.tmp'))).toHaveLength(mac ? 2 : 1)
})

test('a local file narrow enough for its slot is used in place', async () => {
  const file = path.join(dir, 'small.png')
  writeFileSync(file, gradientPng(300, 200))
  expect(await imageFiles(file, 560, 300)).toEqual({ inline: file, full: file })
})

test('a relative path or a remote URL keeps its source', async () => {
  expect(await imageFiles('shots/a.png', 560, null)).toBeNull()
  expect(await imageFiles('https://example.com/a.png', 560, null)).toBeNull()
})

test('fetched bytes are stored once, named by their content', async () => {
  const bytes = gradientPng(40, 40)
  const a = await storeImageBytes(bytes, 'image/png'), b = await storeImageBytes(bytes, 'image/png')
  expect(a).toBe(b)
  expect(existsSync(a)).toBe(true)
})
