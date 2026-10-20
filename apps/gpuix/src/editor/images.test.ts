import { test, expect } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadEditorImage } from './images.ts'

test('editor reloads a reclaimed native decode and shares a pending read', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kybern-editor-image-'))
  const src = path.join(dir, 'fixture.png')
  writeFileSync(src, Buffer.from([1, 2, 3, 4]))
  let resident = false, decodes = 0
  const renderer = {
    hasRichEditorImage: () => resident,
    setRichEditorImage: (_src: string, bytes: Buffer) => { expect([...bytes]).toEqual([1, 2, 3, 4]); decodes++; resident = true },
  }
  try {
    const first = loadEditorImage(renderer, null, src)
    expect(loadEditorImage(renderer, null, src)).toBe(first)
    await first
    await loadEditorImage(renderer, null, src)
    expect(decodes).toBe(1)
    resident = false
    await loadEditorImage(renderer, null, src)
    expect(decodes).toBe(2)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('inline images send only their decoded bytes and reload after eviction', async () => {
  const bytes = Buffer.alloc(7000, 17)
  const src = `data:image/png;base64,${bytes.toString('base64')}`
  let resident = false, decodes = 0
  const renderer = {
    hasRichEditorImage: () => resident,
    setRichEditorImage: (_src: string, decoded: Buffer) => { expect(decoded).toEqual(bytes); decodes++; resident = true },
  }
  await loadEditorImage(renderer, null, src)
  await loadEditorImage(renderer, null, src)
  expect(decodes).toBe(1)
  resident = false
  await loadEditorImage(renderer, null, src)
  expect(decodes).toBe(2)
})
