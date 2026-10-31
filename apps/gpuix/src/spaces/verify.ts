// Drives the real window against a scratch daemon (`PORTING.md` "Daemon safety"):
//
//   KYBERN_DATA_DIR=<…gpuix-scratch…/data> bun src/spaces/verify.ts
//
// One space shows only the "+" tile. A second is created from the rail, switched to by click and
// ⌃1/⌃2, a project moves with "Move to space", another is dragged onto a tile, and deleting a
// space moves its projects. The sidebar's test ids are asserted after each step.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { App } from '@gpuix/react/automation'
import { launchFixture } from '../requests/harness.ts'
import { KybernClient } from '../../../../packages/kybern-client/src/client.ts'

const data = process.env.KYBERN_DATA_DIR ?? ''
if (!data.includes('gpuix-scratch')) throw Error('Scratch daemon required (the data dir must contain "gpuix-scratch")')
const port = readFileSync(path.join(data, 'daemon.port'), 'utf8').trim()
const client = new KybernClient({ url: `ws://127.0.0.1:${port}/ws`, token: readFileSync(path.join(data, 'daemon.token'), 'utf8').trim() })
client.connect()
while (client.status !== 'open') await Bun.sleep(50)

const root = mkdtempSync(path.join(tmpdir(), 'gpuix-scratch-spaces-verify-'))
const folder = (name: string) => { const p = path.join(root, name); mkdirSync(p, { recursive: true }); return p }
const out = process.env.KYBERN_VERIFY_OUTPUT

// A clean slate in this explicitly scratch daemon, including this check's prior attempt.
for (const project of (await client.call('projects.list', { refresh_git: false })).projects) {
  if (project.path.includes('gpuix-scratch-spaces-verify-')) await client.call('projects.remove', { project_id: project.id })
}
// Every Space but the default goes, then two projects land in it.
for (const space of (await client.call('spaces.list', {})).spaces.filter((space) => !space.is_default)) await client.call('spaces.delete', { space_id: space.id })
const personal = (await client.call('spaces.list', {})).spaces.find((space) => space.is_default)!
const alpha = await client.call('projects.add', { path: folder('alpha'), name: 'alpha', space_id: personal.id })
const beta = await client.call('projects.add', { path: folder('beta'), name: 'beta', space_id: personal.id })

let app: App | undefined
let fixture: Awaited<ReturnType<typeof launchFixture>> | undefined
const step = (message: string) => console.log(`- ${message}`)
const has = async (id: string) => (await app!.getByTestId(id).count()) > 0
const until = async (what: string, test: () => Promise<boolean>, ms = 8000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if (await test()) return; await Bun.sleep(80) }
  throw Error(`Timed out: ${what}`)
}
const shot = async (name: string) => { if (out) { await Bun.sleep(300); await app!.screenshot({ path: path.join(out, name) }) } }
const spaces = async () => (await client.call('spaces.list', {})).spaces
const projectSpace = async (id: string) => (await client.call('projects.list', { refresh_git: false })).projects.find((p) => p.id === id)?.space_id

try {
  fixture = await launchFixture(path.resolve('src/main.tsx'), {
      KYBERN_URL: '',
      GPUIX_BACKGROUND: '1',
      KYBERN_DATA_DIR: data,
      KYBERN_CLIENT_CONFIG_DIR: path.join(root, 'config'),
      NAPI_RS_NATIVE_LIBRARY_PATH: process.env.NAPI_RS_NATIVE_LIBRARY_PATH!,
  })
  app = fixture.app
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
  await app.getByTestId('rail-space-new').waitFor({ timeoutMs: 20_000 })

  step('one space: only the "+" tile')
  assert.equal(await has(`rail-space-${personal.id}`), false, 'a single space draws no tile')
  await until('alpha in the sidebar', () => has(`project-${alpha.id}`))
  await shot('one-space.png')

  step('create a space from the rail')
  await app.getByTestId('rail-space-new').click()
  await app.getByTestId('space-editor').waitFor()
  await app.getByTestId('space-name').fill('Work')
  await app.getByTestId('space-icon-5').click()
  await shot('editor.png')
  await app.getByTestId('space-save').click()
  await until('the Work space exists', async () => (await spaces()).length === 2)
  const work = (await spaces())[1]!
  assert.equal(work.name, 'Work')
  assert.deepEqual(work.logo, { kind: 'icon', icon: 'rocket' })
  await until('both tiles and the pill', async () => (await has(`rail-space-${personal.id}`)) && (await has(`rail-space-pill-${work.id}`)))
  step('the new space is active and empty')
  await until('the empty row', () => has('empty-space'))
  assert.equal(await has(`project-${alpha.id}`), false, 'Personal projects are filtered out')
  await shot('empty-space.png')

  step('⌃1 and ⌃2 switch instantly')
  await app.getByTestId('app-ready').press('ctrl-1')
  await until('Personal active', async () => (await has(`rail-space-pill-${personal.id}`)) && (await has(`project-${alpha.id}`)))
  assert.equal(await has('empty-space'), false)
  await app.getByTestId('app-ready').press('ctrl-2')
  await until('Work active', () => has(`rail-space-pill-${work.id}`))

  step('click a tile')
  await app.getByTestId(`rail-space-${personal.id}`).click()
  await until('Personal active again', async () => (await has(`rail-space-pill-${personal.id}`)) && (await has(`project-${beta.id}`)))

  step('Move to space from the project menu')
  await app.getByTestId(`project-${alpha.id}`).click({ button: 2 })
  await app.getByTestId('project-menu').waitFor()
  await app.getByTestId('project-menu-space').hover()
  await app.getByTestId(`move-to-space-${work.id}`).waitFor()
  await shot('move-menu.png')
  await app.getByTestId(`move-to-space-${work.id}`).click()
  await until('alpha moved to Work', async () => (await projectSpace(alpha.id)) === work.id)
  // Moving the open project's draft follows it into its new Space (`current.test.ts`).
  await until('the open project followed into Work', () => has(`rail-space-pill-${work.id}`))
  await app.getByTestId(`rail-space-${personal.id}`).click()
  await until('alpha left Personal', async () => !(await has(`project-${alpha.id}`)) && (await has(`project-${beta.id}`)))
  await app.getByTestId(`rail-space-${work.id}`).click()
  await until('alpha in Work', () => has(`project-${alpha.id}`))
  assert.equal(await has(`project-${beta.id}`), false)

  step('drag a project onto a tile')
  await app.getByTestId(`rail-space-${personal.id}`).click()
  await until('beta in Personal', () => has(`project-${beta.id}`))
  const tile = app.getByTestId(`rail-space-${work.id}`)
  const source = app.getByTestId(`project-${beta.id}`)
  const start = await source.center()
  await app.mouse.down(start, { button: 0 })
  await app.mouse.move({ x: start.x + 14, y: start.y }, { pressedButton: 0 })
  // The capture layer mounts after drag activation; do not release into the previous native hit tree.
  await app.getByTestId('project-drag-layer').waitFor()
  await app.mouse.move(tile, { pressedButton: 0 })
  await app.clock.fastForward(32)
  await app.mouse.up(tile, { button: 0 })
  await app.clock.resume()
  await until('beta moved to Work', async () => (await projectSpace(beta.id)) === work.id)

  // Put a third Space between Work and the default: neither rail-neighbor deletion rule is correct.
  const other = await client.call('spaces.create', { name: 'Other' })
  await client.call('spaces.reorder', { space_ids: [work.id, other.id, personal.id] })
  await until('default reordered to the end', async () => (await spaces()).at(-1)?.id === personal.id)
  await until('the native rail reflects the reordered spaces', async () => {
    const [w, o, p] = await Promise.all([work, other, personal].map((space) => app!.getByTestId(`rail-space-${space.id}`).bounds().catch(() => null)))
    return !!w && !!o && !!p && w.y < o.y && o.y < p.y
  })
  step('delete a space moves its projects to the default')
  await app.getByTestId(`rail-space-${work.id}`).click({ button: 2 })
  await app.getByTestId('space-menu').waitFor()
  await app.getByTestId('space-menu-delete').click()
  await app.getByTestId('delete-space').waitFor()
  await app.getByText('Delete “Work”?').waitFor()
  await shot('delete.png')
  await app.getByTestId('delete-space-confirm').click()
  await until('two spaces left', async () => (await spaces()).length === 2)
  assert.equal(await projectSpace(alpha.id), personal.id)
  assert.equal(await projectSpace(beta.id), personal.id)
  await client.call('spaces.delete', { space_id: other.id })
  await until('one space left', async () => (await spaces()).length === 1)
  await until('the rail hides its tiles again', async () => !(await has(`rail-space-${personal.id}`)))
  await until('both projects listed', async () => (await has(`project-${alpha.id}`)) && (await has(`project-${beta.id}`)))
  console.log('spaces verify: ok')
} catch (error) {
  await shot("failed.png")
  throw error
} finally {
  await fixture?.close()
  client.close()
}
