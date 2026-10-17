// The shared editor inside the app, against this lane's own scratch daemon: a live task
// chip, "Make task" from a checklist line (hover button and ⌘⇧T), an image dropped from
// Finder, quick capture, and a task description edited in place. Asserts what the
// daemon stores. Never touches ~/.kybern.
//
//   bun src/editor/app-check.ts
import '../native/local-build.ts'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import { launchFixture } from '../requests/harness.ts'

const root = process.env.KYBERN_EDITOR_SCRATCH ?? '/Users/mymac/projects/ade-gpuix-scratch/phase2-editor9'
const data = path.join(root, 'daemon'), out = process.env.KYBERN_VERIFY_OUTPUT ?? '/Users/mymac/projects/ade/previews/gpuix/phase2/editor9/app'
const appearance = process.env.KYBERN_APPEARANCE ?? 'dark'
mkdirSync(data, { recursive: true }); mkdirSync(out, { recursive: true })
const daemon = spawn('/Applications/kybern.app/Contents/MacOS/kybernd', ['--data-dir', data, '--port', '4303'], { stdio: 'ignore' })
const until = async <T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 15000): Promise<T> => {
  const deadline = Date.now() + ms
  for (;;) { const v = await read().catch(() => undefined as T); if (v !== undefined && ok(v)) return v; if (Date.now() > deadline) throw new Error(`${what}: ${JSON.stringify(v)?.slice(0, 400)}`); await Bun.sleep(100) }
}
await until(async () => existsSync(path.join(data, 'daemon.token')), Boolean, 'scratch daemon')
const token = readFileSync(path.join(data, 'daemon.token'), 'utf8').trim()
const client = new KybernClient({ url: 'ws://127.0.0.1:4303/ws', token }, { createSocket: (url, key) => new WebSocket(url, { headers: { origin: 'tauri://localhost', Authorization: `Bearer ${key}` } } as unknown as string[]) })
await new Promise<void>((resolve) => { client.onStatus((s) => { if (s === 'open') resolve() }); client.connect() })

mkdirSync(path.join(root, 'project'), { recursive: true })
if (!(await client.call('projects.list', {})).projects.length) await client.call('projects.add', { path: path.join(root, 'project'), name: 'editor-project' })
const task = await client.call('tasks.items.create', { scope: 'global', project_id: null, title: 'Review the editor', status: 'todo' })
const title = `Editor app check ${Date.now()}`
const note = await client.call('notes.create', { scope: 'global', project_id: null, title, body: `# Plan\n\n- [ ] Write the release notes\n- [ ] Review [${task.key}](kybern://task/${task.id})\n\nDrop an image below.\n` })
// The branded release artwork as the dropped file.
const png = path.join(root, 'moodboard.png')
copyFileSync(path.resolve(import.meta.dir, '../../../desktop/public/release-background.png'), png)

const f = await launchFixture(path.resolve(import.meta.dir, '../main.tsx'), { GPUIX_BACKGROUND: '1', KYBERN_OPAQUE: '1', KYBERN_APPEARANCE: appearance, KYBERN_DATA_DIR: data, KYBERN_CLIENT_CONFIG_DIR: path.join(root, 'app-client'), KYBERN_GPUIX_CREDENTIALS_DIR: path.join(root, 'app-credentials'), KYBERN_URL: '' })
const a = f.app
const painted = async () => (await a.call('getPaintedText', {})).text.join('\n')
const body = async () => (await client.call('notes.get', { id: note.id })).note!.body
try {
  await a.getByTestId('app-ready').waitFor({ timeoutMs: 60000 })
  await a.getByTestId('rail-notes').click(); await Bun.sleep(500)
  await a.getByTestId('notes-search').fill(title); await Bun.sleep(600)
  await a.getByTestId(`note-card-${note.id}`).click()
  await a.getByTestId('note-body').waitFor()
  // The reference reads as the task's key and live status.
  await until(painted, (t) => t.includes(task.key) && t.includes('To do') && !t.includes('kybern://task'), 'live task chip')
  await a.screenshot({ path: path.join(out, `note-${appearance}.png`) })

  // Hovering an unlinked checklist line offers "Make task".
  const box = await a.getByTestId('note-body').bounds()
  let found = false
  for (let y = box.y + 4; y < box.y + box.height && !found; y += 6) { await a.mouse.move({ x: box.x + 120, y }); found = (await a.getByTestId('editor-make-task').count()) > 0 }
  assert.ok(found, 'Make task appears on a checklist line')
  await a.screenshot({ path: path.join(out, `make-task-hover-${appearance}.png`) })
  await a.getByTestId('editor-make-task').click()
  const made = await until(async () => (await client.call('tasks.items.list', {})).tasks.find((t) => t.title === 'Write the release notes'), Boolean, 'task made from the line')
  await until(body, (b) => b.includes(`kybern://task/${made!.id}`), 'the daemon links the line to its task')
  await until(painted, (t) => t.includes(made!.key), 'the new reference shows in the open note')
  await a.screenshot({ path: path.join(out, `make-task-done-${appearance}.png`) })

  // An image dropped from Finder is kept by the note's daemon and shown in place.
  // At the end of the last line (a drop inside a paragraph splits it, as on the desktop).
  await a.call('fileDrop' as never, { x: box.x + box.width - 4, y: box.y + box.height - 10, paths: [png] } as never)
  await until(body, (b) => /Drop an image below\.\n\n!\[[^\]]*\]\(kybern:\/\/asset\/[^)]+\)/.test(b), 'dropped image stored where it was dropped')
  await Bun.sleep(600)
  await a.screenshot({ path: path.join(out, `image-${appearance}.png`) })

  // Quick capture writes formatted text.
  await a.getByTestId('app-ready').press('cmd-shift-n')
  await a.getByTestId('quick-note-title').waitFor()
  await a.getByTestId('quick-note-title').fill('Quick editor capture')
  await a.getByTestId('quick-note-title').press('enter')
  for (const k of ['Q', 'u', 'i', 'c', 'k', 'space', 'cmd-b', 'b', 'o', 'l', 'd']) await a.getByTestId('quick-note-body').press(k)
  await a.screenshot({ path: path.join(out, `quick-${appearance}.png`) })
  await a.getByTestId('quick-note-body').press('cmd-enter')
  await until(async () => (await client.call('notes.list', {})).notes.find((n) => n.title === 'Quick editor capture'), Boolean, 'quick note saved')
  const quick = (await client.call('notes.list', {})).notes.find((n) => n.title === 'Quick editor capture')!
  assert.equal((await client.call('notes.get', { id: quick.id })).note!.body, 'Quick **bold**\n')

  // The task description is edited in place with the same editor.
  await a.getByTestId('rail-tasks').click(); await Bun.sleep(600)
  await a.getByTestId(`task-drag-${task.id}`).click(); await Bun.sleep(800)
  await a.getByTestId('task-desc-input').click()
  for (const k of ['#', '#', 'space', 'G', 'o', 'a', 'l']) await a.getByTestId('task-desc-input').press(k)
  await a.getByTestId('task-desc-input').press('escape')
  await until(async () => (await client.call('tasks.items.get', { id: task.id })).task!.body, (b) => b.startsWith('## Goal'), 'task description saved')
  await a.screenshot({ path: path.join(out, `task-desc-${appearance}.png`) })
  console.log(`ok ${appearance}: live chip, Make task (hover) linked by the daemon, dropped image stored, quick capture "**bold**", task description "## Goal"`)
} catch (error) { console.error(f.diagnostics()); await a.screenshot({ path: path.join(out, `failure-${appearance}.png`) }).catch(() => {}); throw error }
finally {
  await f.close(); client.close()
  daemon.kill(); await new Promise((r) => daemon.once('exit', r))
  if (process.env.KYBERN_EDITOR_KEEP !== '1') rmSync(data, { recursive: true, force: true })
}
