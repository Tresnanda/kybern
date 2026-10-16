// Scratch-only check of the task page edited in place and the new-task card. Drives the real window:
// click, type, Return, Escape, Backspace; asserts what the daemon saved and what is painted.
//   KYBERN_DATA_DIR=/Users/mymac/projects/ade-gpuix-scratch/data bun src/tasks/inplace.verify.ts [--light]
import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { launch, type App } from '@gpuix/react/automation'
import { KybernClient } from '../../../../packages/kybern-client/src/client.ts'

const scratch = path.resolve(process.env.KYBERN_DATA_DIR ?? '')
if (!scratch.includes('gpuix-scratch')) throw new Error('This check writes tasks: set KYBERN_DATA_DIR to the GPUIX scratch daemon.')
const light = process.argv.includes('--light')
const out = process.env.KYBERN_VERIFY_OUTPUT ?? '/Users/mymac/projects/ade/previews/gpuix/tasks3/inplace'
mkdirSync(out, { recursive: true })
const client = new KybernClient(
  { url: `ws://127.0.0.1:${readFileSync(path.join(scratch, 'daemon.port'), 'utf8').trim()}/ws`, token: readFileSync(path.join(scratch, 'daemon.token'), 'utf8').trim() },
  { createSocket: (url, token) => new WebSocket(url, { headers: { origin: 'tauri://localhost', Authorization: `Bearer ${token}` } } as unknown as string[]) },
)
await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Connection timeout')), 10000)
  client.onStatus((s) => { if (s === 'open') { clearTimeout(timer); resolve() } })
  client.connect()
})
const ids: string[] = []
let app: App | null = null
const tag = `GPUIX in place ${Date.now()}`
async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, label: string, timeout = 15000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await fn()
    if (ok(v)) return v
    if (Date.now() - start > timeout) throw new Error(`Timeout: ${label}`)
    await Bun.sleep(100)
  }
}
const get = (id: string) => client.call('tasks.items.get', { id }).then((r) => r.task!)
const click = async (testId: string) => { const l = app!.getByTestId(testId); await l.waitFor({ timeoutMs: 15000 }); await l.hover(); await app!.clock.fastForward(32); await l.click() }
const shot = (name: string) => app!.screenshot({ path: path.join(out, `${name}-${light ? 'light' : 'dark'}.png`) })

try {
  const project = (await client.call('projects.list', {})).projects.find((p) => p.name === 'scratch-project')!
  const task = await client.call('tasks.items.create', { scope: 'project', project_id: project.id, title: `${tag} page`, body: 'A plain description.\n\n- [ ] First criterion\n- [x] Second criterion', status: 'todo' })
  ids.push(task.id)
  app = await launch({ command: 'bun', args: [path.resolve(import.meta.dir, '../main.tsx')], env: { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: light ? 'light' : 'dark', KYBERN_DATA_DIR: scratch, NAPI_RS_NATIVE_LIBRARY_PATH: process.env.NAPI_RS_NATIVE_LIBRARY_PATH } })
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 60000 })
  await click('rail-tasks')
  await click(`task-filter-project:${project.id}`)
  await click('task-view-board')
  await app.getByTestId('task-board').waitFor()

  // ---- the new-task card (board) ----
  await app.getByTestId('task-column-todo').hover()
  await click('task-board-add-todo')
  await app.getByTestId('task-quick-card').waitFor()
  if (await app.getByTestId('task-quick-add').count()) throw new Error('The card has an Add task button; the desktop has none')
  await shot('quick-card')
  await app.getByTestId('task-quick-title').fill(`${tag} card`)
  await app.getByTestId('task-quick-title').press('enter')
  const added = await until(() => client.call('tasks.items.list', {}), (r) => r.tasks.some((v) => v.title === `${tag} card`), 'Return adds the task')
  ids.push(added.tasks.find((v) => v.title === `${tag} card`)!.id)
  if (!(await app.getByTestId('task-quick-card').count())) throw new Error('Return should keep the card open for the next task')
  await app.getByTestId('task-quick-title').press('escape')
  await until(() => app!.getByTestId('task-quick-card').count(), (n) => n === 0, 'Escape closes the card')
  // Shift+Return inserts a line; selecting a project keeps the draft, clicking outside adds it.
  await app.getByTestId('task-column-todo').hover()
  await click('task-board-add-todo')
  await app.getByTestId('task-quick-title').fill(`${tag} away`)
  await app.getByTestId('task-quick-title').press('shift-enter')
  if ((await client.call('tasks.items.list', {})).tasks.some((v) => v.title === `${tag} away`)) throw new Error('Shift+Return submitted the card')
  await click('task-quick-project')
  await click(`task-quick-project-${project.id}`)
  if (!(await app.getByTestId('task-quick-card').count())) throw new Error('Choosing a project closed the draft')
  const col = await app.getByTestId('task-column-todo').bounds()
  await app.mouse.move({ x: col.x + 40, y: col.y + 10 })
  await app.clock.fastForward(32)
  await app.mouse.click({ x: col.x + 40, y: col.y + 10 })
  const away = await until(() => client.call('tasks.items.list', {}), (r) => r.tasks.some((v) => v.title.trim() === `${tag} away`), 'clicking away saves the draft')
  ids.push(away.tasks.find((v) => v.title.trim() === `${tag} away`)!.id)
  await until(() => app!.getByTestId('task-quick-card').count(), (n) => n === 0, 'clicking away closes the card')
  console.log('QUICK ADD CARD OK')

  // ---- the page, edited where it sits ----
  await click('task-view-list')
  await click(`task-row-${task.id}`)
  await app.getByTestId('task-detail').waitFor()
  await app.getByTestId('task-title').waitFor()
  for (const gone of ['task-edit-done', 'task-edit-title', 'task-edit-body', 'note-format-bold']) if (await app.getByTestId(gone).count()) throw new Error(`${gone} is a form control the desktop page does not have`)
  await shot('page-reading')

  await click('task-title')
  await app.getByTestId('task-title').fill(`${tag} renamed`)
  await app.getByTestId('task-title').press('enter')
  await until(() => get(task.id), (t) => t.title === `${tag} renamed`, 'title saved on Return')
  await app.getByTestId('task-desc-input').waitFor()
  await app.getByTestId('task-desc-input').fill('An edited description with `code` and **bold**.')
  await until(() => get(task.id), (t) => t.body.startsWith('An edited description'), 'description autosaved')
  await shot('page-editing-description')
  await app.getByTestId('task-desc-input').press('escape')
  await until(() => app!.getByTestId('task-desc-input').count(), (n) => n === 0, 'Escape leaves the description')
  await app.getByTestId('task-desc').waitFor()
  console.log('TITLE AND DESCRIPTION OK')

  await click('task-criterion-0')
  await until(() => get(task.id), (t) => t.body.includes('- [x] First criterion'), 'checkbox toggled')
  await click('task-criterion-text-0')
  await click('task-criterion-0')
  await until(() => get(task.id), (t) => t.body.includes('- [ ] First criterion'), 'filled checkbox toggled off after hover')
  await click('task-criterion-0')
  await app.getByTestId('task-criterion-text-0').fill('First criterion, edited')
  await app.getByTestId('task-criterion-text-0').press('enter')
  await app.getByTestId('task-criterion-text-1').waitFor()
  await app.getByTestId('task-criterion-text-1').fill('Inserted after Return')
  await app.getByTestId('task-criterion-text-1').press('enter')
  await app.getByTestId('task-criterion-text-3').waitFor() // First, Inserted, the new empty one, Second
  await app.getByTestId('task-criterion-text-2').press('backspace')
  await until(() => app!.getByTestId('task-criterion-text-3').count(), (n) => n === 0, 'Backspace removes the empty row')
  await until(() => get(task.id), (t) => t.body.includes('- [x] First criterion, edited') && t.body.includes('- [ ] Inserted after Return') && t.body.includes('- [x] Second criterion'), 'criteria saved')
  await click('task-add-criterion')
  await app.getByTestId('task-criterion-text-3').waitFor()
  await app.getByTestId('task-criterion-text-3').fill('Added with the row below the list')
  await until(() => get(task.id), (t) => t.body.includes('- [ ] Added with the row below the list'), 'added criterion saved')
  await shot('page-criteria')
  console.log('CRITERIA OK')
} finally {
  for (const id of ids) await client.call('tasks.items.delete', { id }).catch(() => {})
  await app?.close?.().catch(() => {})
  client.close?.()
}
console.log('IN PLACE OK')
process.exit(0)
