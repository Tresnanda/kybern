import assert from 'node:assert/strict'
import { readFileSync, mkdirSync } from 'node:fs'
import { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import { launchFixture } from '../requests/harness.ts'
const data = process.env.KYBERN_DATA_DIR!
assert.ok(data.includes('gpuix-scratch'))
const client = new KybernClient({ url: `ws://127.0.0.1:${readFileSync(data + '/daemon.port', 'utf8').trim()}/ws`, token: readFileSync(data + '/daemon.token', 'utf8').trim() })
client.connect()
while (client.status !== 'open') await Bun.sleep(30)
const out = process.env.KYBERN_VERIFY_OUTPUT ?? '/Users/mymac/projects/ade/previews/gpuix/p3'
mkdirSync(out, { recursive: true })
try {
  for (const variant of ['dark', 'light']) {
    const f = await launchFixture(import.meta.dir + '/note.fixture.tsx', { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: variant })
    try {
      await f.app.getByTestId('answer-save-note').waitFor({ timeoutMs: 15000 })
      await f.app.getByTestId('answer-save-note').click()
      await f.app.getByTestId('save-to-note').waitFor()
      await f.app.screenshot({ path: `${out}/save-note-${variant}.png` })
      await f.app.getByTestId('save-note-new').click()
      let notes = (await client.call('notes.list', {})).notes
      for (let i=0;i<50 && !notes.some(n => n.title.includes('Verification'));i++) { await Bun.sleep(50); notes=(await client.call('notes.list', {})).notes }
      const note = notes.find(n => n.title.includes('Verification'))!
      assert.ok(note)
      const original = (await client.call('notes.get', { id: note.id })).note!
      assert.ok(original.body.includes('**formatted text**'))
      assert.ok(original.body.includes('export const example = 1;'))
      await f.app.getByTestId('answer-save-note').click()
      await f.app.getByTestId(`save-note-${note.id}`).waitFor()
      await f.app.getByTestId(`save-note-${note.id}`).click()
      let saved = original
      for (let i=0;i<50 && saved.revision===original.revision;i++) { await Bun.sleep(50); saved=(await client.call('notes.get', { id: note.id })).note! }
      assert.ok(saved.body.length > original.body.length)
      assert.equal(saved.body.split('export const example = 1;').length, 3)
      console.log(`PASS ${variant}: transcript → picker → create → append; exact Markdown persisted`)
      await client.call('notes.delete', { id: note.id })
      await client.call('notes.purge', { id: note.id })
    } finally { await f.close() }
  }
} finally { client.close() }
process.exit(0)
