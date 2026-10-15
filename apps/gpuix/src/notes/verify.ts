// Scratch-only integration + native UI verification. Always closes its window.
// Run from apps/gpuix with the patched NAPI_RS_NATIVE_LIBRARY_PATH exported.
import { readFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import assert from 'node:assert/strict'
import { launch } from '@gpuix/react/automation'
import { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import { splitBlocks } from './blocks.ts'

const data = (process.env.KYBERN_DATA_DIR ?? '/Users/mymac/projects/ade-gpuix-scratch/data')
const out = process.env.KYBERN_VERIFY_OUTPUT ?? '/Users/mymac/projects/ade/previews/gpuix/notes'
const port = readFileSync(path.join(data, 'daemon.port'), 'utf8').trim()
const token = readFileSync(path.join(data, 'daemon.token'), 'utf8').trim()
const client = new KybernClient({ url: `ws://127.0.0.1:${port}/ws`, token }, { createSocket: (url, key) => new WebSocket(url, { headers: { origin: 'tauri://localhost', Authorization: `Bearer ${key}` } } as unknown as string[]) })
const ready = new Promise<void>((resolve) => client.onStatus((status) => { if (status === 'open') resolve() }))
client.connect(); await ready
mkdirSync(out, { recursive: true })
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function click(id: string) {
  console.log('Click', id)
  await app!.getByTestId(id).waitFor({ timeoutMs: 15000 })
  for (let attempt = 0; attempt < 30; attempt++) {
    const bounds = await app!.getByTestId(id).bounds().catch(() => null)
    if (bounds && bounds.width > 0 && bounds.height > 0) { await app!.getByTestId(id).click(); return }
    if (id.startsWith('note-card-')) await app!.getByTestId('notes-gallery').wheel(0, -300)
    await pause(100)
  }
  throw Error(`No painted bounds: ${id}`)
}
const watchdog = setTimeout(() => { console.error('Verification timed out'); void app?.close() }, 240_000)
// Recover fixtures left by an interrupted prior run, matching both our title and
// our distinctive body. All calls remain on the explicitly named scratch daemon.
if (process.env.NOTES_CLEANUP_FIXTURES === '1') {
  const titles = new Set(['A quieter workspace', 'Ideas for the next release', 'Before we ship', 'Meeting notes', 'Reading and references', 'Small things to remember', 'Autosave verified', 'Quick capture verified'])
  for (const summary of (await client.call('notes.list', {})).notes) {
    if (!titles.has(summary.title)) continue
    const note = (await client.call('notes.get', { id: summary.id })).note
    if (note && ['const idea = "make room"', 'A focused document with clear typography', 'Review the gallery', 'The draft survives until the daemon confirms the save.'].some((marker) => note.body.includes(marker))) {
      await client.call('notes.delete', { id: note.id }); await client.call('notes.purge', { id: note.id })
      console.log('Removed interrupted verification fixture', note.title)
    }
  }
}
const ids: string[] = []
const taskIds: string[] = []
const bodies = [
  '# A quieter workspace\n\nA place for ideas, decisions, and the details worth remembering.\n\n## Next steps\n\n- [ ] Try the native Notes editor\n- [x] Keep the original Markdown\n\n```ts\nconst idea = "make room"\n\nconsole.log(idea)\n```\n',
  'A focused document with clear typography, a small outline, and just enough structure.\n\n## Reading list\n\n[GPUIX](https://github.com/remorses/gpuix)\n',
  '## Release checklist\n\n- [x] Review the gallery\n- [ ] Check light and dark appearances\n- [ ] Measure typing latency\n',
]
for (const body of bodies) assert.equal(splitBlocks(body).join(''), body)
let app: Awaited<ReturnType<typeof launch>> | undefined
try {
  for (const [i, title] of ['A quieter workspace', 'Ideas for the next release', 'Before we ship', 'Meeting notes', 'Reading and references', 'Small things to remember'].entries()) {
    const note = await client.call('notes.create', { scope: 'global', title, body: bodies[i % bodies.length] })
    ids.push(note.id)
    if (i < 2) await client.call('notes.pin', { id: note.id, pinned: true })
  }
  const linked = await client.call('tasks.items.create', { scope: 'global', title: 'Check image and task references', status: 'todo' })
  taskIds.push(linked.id)
  const upload = await fetch(`http://127.0.0.1:${port}/assets`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'image/png', 'x-kybern-filename': 'reference.png' }, body: await Bun.file('../desktop/public/release-background.png').arrayBuffer() })
  assert.equal(upload.ok, true)
  const asset = await upload.json() as { id: string }
  const media = await client.call('notes.create', { scope: 'global', title: 'Inline reference verification', body: `![Reference artwork](kybern://asset/${asset.id})\n\n[${linked.key}](kybern://task/${linked.id})\n` })
  ids.push(media.id)
  for (const appearance of ['dark', 'light']) {
    app = await launch({ command: 'bun', args: [path.resolve('src/main.tsx')], env: { GPUIX_BACKGROUND: '1', KYBERN_DATA_DIR: data, KYBERN_APPEARANCE: appearance, NAPI_RS_NATIVE_LIBRARY_PATH: process.env.NAPI_RS_NATIVE_LIBRARY_PATH! } })
    await app.getByTestId('app-ready').waitFor({ timeoutMs: 30000 }); await pause(1500)
    await click('rail-notes'); await pause(500)
    if (await app.getByTestId('notes-back').count()) { await click('notes-back'); await pause(300) }
    await app.screenshot({ path: `${out}/gallery-${appearance}.png` })
    console.log('open document', appearance)
    await click(`note-card-${ids[0]}`); await pause(500)
    await app.screenshot({ path: `${out}/document-${appearance}.png` })
    if (appearance === 'dark' && !process.env.NOTES_SCREENSHOTS_ONLY) {
      console.log('edit native block')
      await click('note-block-0'); await pause(100)
      const input = app.getByTestId('note-block-input-0')
      const latency: number[] = []
      for (let i = 0; i < 2; i++) { const start = performance.now(); await input.fill(`# A quieter workspace ${i}\n\n`); latency.push(performance.now() - start) }
      console.log('native fill round-trip ms', JSON.stringify(latency))
      for (let retry = 0; retry < 20; retry++) { await input.element(); await pause(200); if ((await client.call('notes.get', { id: ids[0] })).note?.body.startsWith('# A quieter workspace 1')) break }
      const saved = (await client.call('notes.get', { id: ids[0] })).note!
      console.log('saved body', JSON.stringify(saved.body)); await app.screenshot({ path: `${out}/editing-dark.png` }); assert.ok(saved.body.startsWith('# A quieter workspace 1'))
      assert.ok(saved.body.includes('console.log(idea)'))
      await click('note-done-editing')
      await app.getByTestId('note-title').fill('Autosave verified')
      await click('notes-back'); await pause(2000)
      assert.equal((await client.call('notes.get', { id: ids[0] })).note!.title, 'Autosave verified')
      // Gallery display/search and the menu's reversible delete/restore path.
      await click('notes-display'); await pause(150)
      await click('notes-layout-list'); await pause(200)
      await app.screenshot({ path: `${out}/list-dark.png` })
      await app.getByTestId('notes-search').fill('Autosave verified'); await pause(500)
      assert.equal(await app.getByTestId(`note-card-${ids[0]}`).count(), 1)
      await click(`note-card-${ids[0]}`); await pause(300)
      await click('note-pin'); await pause(300)
      assert.equal((await client.call('notes.get', { id: ids[0] })).note!.pinned, false)
      await click('note-menu-more'); await pause(150)
      await click('note-delete'); await pause(300)
      assert.ok((await client.call('notes.get', { id: ids[0] })).note!.deleted_at)
      await click('notes-filter-deleted'); await pause(300)
      await click(`note-card-${ids[0]}`); await pause(300)
      await click('note-restore'); await pause(400)
      assert.ok(!(await client.call('notes.get', { id: ids[0] })).note!.deleted_at)
      await click('notes-back'); await pause(250)
      await click('notes-filter-all')
      await click('notes-display'); await pause(150)
      await click('notes-layout-gallery'); await pause(200)
      console.log('PASS gallery list/search and Pin/Delete/Restore UI')
      await app.getByTestId('app-ready').press('cmd-shift-n'); await pause(200)
      await app.getByTestId('quick-note-title').fill('Quick capture verified')
      await app.getByTestId('quick-note-body').fill('The draft survives until the daemon confirms the save.')
      await app.screenshot({ path: `${out}/quick-capture-dark.png` })
      await click('quick-note-save'); await pause(500)
      const quick = (await client.call('notes.list', {})).notes.find((n) => n.title === 'Quick capture verified')
      assert.ok(quick); ids.push(quick.id)
      await app.getByTestId('app-ready').press('cmd-k'); await pause(200)
      await app.getByTestId('palette-input').fill('Autosave verified'); await pause(200)
      await app.screenshot({ path: `${out}/palette-dark.png` })
      assert.ok(await app.getByTestId(`palette-item-note:${ids[0]}`).count())
      await app.getByTestId('palette-input').press('escape'); await pause(200)
      // Locate only this worktree's child. Never sample or stop another agent's window.
      const listing = execFileSync('ps', ['-axo', 'pid,command'], { encoding: 'utf8' })
      const line = listing.split('\n').find((line) => line.includes(`bun ${path.resolve('src/main.tsx')}`))
      const pid = line?.trim().split(/\s+/)[0]
      if (pid && !process.env.NOTES_SKIP_PERF) {
        console.log('gallery idle sample')
        const sampler = Bun.spawn(['bun', 'perf/sample.ts', '15', `GPUIX=${pid}`], { stdout: 'pipe', stderr: 'pipe' })
        console.log(await new Response(sampler.stdout).text()); assert.equal(await sampler.exited, 0)
        console.log('open document', appearance)
    await click(`note-card-${ids[0]}`); await pause(500)
        console.log('document idle sample')
        const doc = Bun.spawn(['bun', 'perf/sample.ts', '15', `GPUIX=${pid}`], { stdout: 'pipe', stderr: 'pipe' })
        console.log(await new Response(doc.stdout).text()); assert.equal(await doc.exited, 0)
        await click('note-block-0'); await pause(150)
        console.log('typing sample: individual native keystrokes over 15 s')
        const active = Bun.spawn(['bun', 'perf/sample.ts', '15', `GPUIX=${pid}`], { stdout: 'pipe', stderr: 'pipe' })
        const keys: number[] = []; const until = Date.now() + 15000; while (Date.now() < until) { const start = performance.now(); await app.getByTestId('note-block-input-0').press('a'); keys.push(performance.now() - start); await pause(200) }; console.log('single-key round-trip ms', JSON.stringify(keys))
        console.log(await new Response(active.stdout).text()); assert.equal(await active.exited, 0)
      }
    }
    if (await app.getByTestId('notes-back').count()) await click('notes-back')
    await app.getByTestId('notes-search').fill('Inline reference verification'); await pause(500)
    await click(`note-card-${media.id}`)
    await app.getByTestId('note-image').waitFor({ timeoutMs: 15000 })
    await app.getByTestId(`note-inline-task-${linked.id}`).waitFor({ timeoutMs: 15000 })
    await app.screenshot({ path: `${out}/image-task-${appearance}.png` })
    await app.close(); app = undefined
  }
  console.log('PASS: lossless blocks, native gallery/document, autosave, unmount flush, quick capture, palette')
} finally {
  if (app) await app.close()
  for (const id of ids) { await client.call('notes.delete', { id }); await client.call('notes.purge', { id }) }
  for (const id of taskIds) await client.call('tasks.items.delete', { id })
  client.close(); clearTimeout(watchdog)
}
