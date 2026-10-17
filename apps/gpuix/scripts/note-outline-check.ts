import assert from 'node:assert/strict'
import { readFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { launch } from '@gpuix/react/automation'
import { KybernClient } from '../../../packages/kybern-client/src/client.ts'
import { splitBlocks } from '../src/notes/blocks.ts'
const data = process.env.KYBERN_DATA_DIR ?? ''
if (!data.includes('gpuix-scratch/drag-release/')) throw Error('Dedicated scratch daemon required')
const out = '/Users/mymac/projects/ade/previews/gpuix/note-outline'
mkdirSync(out, { recursive: true })
const client = new KybernClient({ url: `ws://127.0.0.1:${readFileSync(path.join(data, 'daemon.port'), 'utf8').trim()}/ws`, token: readFileSync(path.join(data, 'daemon.token'), 'utf8').trim() })
client.connect(); while (client.status !== 'open') await Bun.sleep(50)
const body = Array.from({ length: 6 }, (_, i) => `## Section ${i + 1}\n\n` + Array.from({ length: 7 }, (_, p) => `Paragraph ${p + 1}. This is a readable note section with enough text to exercise scrolling through virtual rows.\n\n`).join('')).join('')
const headings = splitBlocks(body).flatMap((block, index) => block.startsWith('## ') ? [index] : [])
const note = await client.call('notes.create', { scope: 'global', title: 'Outline follows reading', body })
const app = await launch({ command: 'bun', args: [path.resolve('src/main.tsx')], env: { GPUIX_BACKGROUND: '1', KYBERN_DATA_DIR: data, KYBERN_APPEARANCE: process.env.KYBERN_APPEARANCE ?? 'dark', KYBERN_REDUCED_MOTION: process.env.KYBERN_REDUCED_MOTION ?? '0', KYBERN_OPAQUE: '1' } })
try {
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 30000 })
  await app.getByTestId('rail-notes').click(); await Bun.sleep(300); if (await app.getByTestId('notes-back').count()) await app.getByTestId('notes-back').click()
  await app.getByTestId(`note-card-${note.id}`).waitFor(); await app.getByTestId(`note-card-${note.id}`).click(); console.log('opened')
  await app.getByTestId('note-body-list').waitFor()
  if (!(await app.getByTestId(`note-outline-${headings[0]}`).count())) {
    await app.getByTestId('note-format-outline').click()
  }
  await app.getByTestId(`note-outline-active-${headings[0]}`).waitFor()
  for (const section of [2, 4, 1]) {
    await app.getByTestId(`note-outline-${headings[section]}`).click()
    await Bun.sleep(400)
    await app.getByTestId(`note-outline-active-${headings[section]}`).waitFor()
    console.log(`PASS outline click section ${section + 1}`)
  }
  await app.getByTestId(`note-outline-${headings[3]}`).click()
  await Bun.sleep(400)
  await app.getByTestId(`note-outline-active-${headings[3]}`).waitFor()
  await app.screenshot({ path: `${out}/section4-${process.env.KYBERN_APPEARANCE ?? 'dark'}-${process.env.KYBERN_REDUCED_MOTION ?? '0'}.png` })
  await app.getByTestId(`note-outline-${headings[1]}`).click()
  await Bun.sleep(400)
  await app.getByTestId('note-viewport').wheel(0, -1200)
  await Bun.sleep(500)
  const active = (await Promise.all(headings.map(async (h, i) => await app.getByTestId(`note-outline-active-${h}`).count() ? i : -1))).find(i => i >= 0)
  assert.ok(active !== undefined && active > 1, `Scrolling down must advance past section 2, got ${active}`)
  await app.screenshot({ path: `${out}/scrolled-${process.env.KYBERN_APPEARANCE ?? 'dark'}-${process.env.KYBERN_REDUCED_MOTION ?? '0'}.png` })
  await app.getByTestId('note-viewport').wheel(0, 10000)
  await Bun.sleep(500)
  await app.getByTestId(`note-outline-active-${headings[0]}`).waitFor()
  console.log('PASS wheel scroll changes active heading and returns to first section')
} finally {
  await app.close()
  if (!process.env.KYBERN_KEEP_FIXTURE) await client.call('notes.delete', { id: note.id })
  client.close()
}
