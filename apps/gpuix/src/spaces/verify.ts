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
import { launch, type App } from '@gpuix/react/automation'
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

// A clean slate: every space but the first goes, then two projects land in it.
for (const space of (await client.call('spaces.list', {})).spaces.slice(1)) await client.call('spaces.delete', { space_id: space.id })
const personal = (await client.call('spaces.list', {})).spaces[0]!
const alpha = await client.call('projects.add', { path: folder('alpha'), name: 'alpha', space_id: personal.id })
const beta = await client.call('projects.add', { path: folder('beta'), name: 'beta', space_id: personal.id })

let app: App | undefined
const step = (message: string) => console.log(`- ${message}`)
const has = async (id: string) => (await app!.getByTestId(id).count()) > 0
const until = async (what: string, test: () => Promise<boolean>, ms = 8000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if (await test()) return; await Bun.sleep(80) }
  throw Error(`Timed out: ${what}`)
}
const shot = async (name: string) => { if (out) await app!.screenshot({ path: path.join(out, name) }) }
const spaces = async () => (await client.call('spaces.list', {})).spaces
const projectSpace = async (id: string) => (await client.call('projects.list', { refresh_git: false })).projects.find((p) => p.id === id)?.space_id

try {
  app = await launch({
    command: 'bun',
    args: [path.resolve('src/main.tsx')],
    env: {
      GPUIX_BACKGROUND: '1',
      KYBERN_DATA_DIR: data,
      KYBERN_CLIENT_CONFIG_DIR: path.join(root, 'config'),
      NAPI_RS_NATIVE_LIBRARY_PATH: process.env.NAPI_RS_NATIVE_LIBRARY_PATH!,
    },
  })
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
  await until('alpha left Personal', async () => !(await has(`project-${alpha.id}`)))
  assert.equal(await projectSpace(alpha.id), work.id)
  assert.equal(await has(`project-${beta.id}`), true)
  await app.getByTestId(`rail-space-${work.id}`).click()
  await until('alpha in Work', () => has(`project-${alpha.id}`))
  assert.equal(await has(`project-${beta.id}`), false)

  step('drag a project onto a tile')
  await app.getByTestId(`rail-space-${personal.id}`).click()
  await until('beta in Personal', () => has(`project-${beta.id}`))
  const tile = app.getByTestId(`rail-space-${work.id}`)
  await app.getByTestId(`project-${beta.id}`).dragTo(tile, { steps: 12 })
  await until('beta moved to Work', async () => (await projectSpace(beta.id)) === work.id)

  step('delete a space moves its projects up')
  await app.getByTestId(`rail-space-${work.id}`).click({ button: 2 })
  await app.getByTestId('space-menu').waitFor()
  await app.getByTestId('space-menu-delete').click()
  await app.getByTestId('delete-space').waitFor()
  await shot('delete.png')
  await app.getByTestId('delete-space-confirm').click()
  await until('one space left', async () => (await spaces()).length === 1)
  assert.equal(await projectSpace(alpha.id), personal.id)
  assert.equal(await projectSpace(beta.id), personal.id)
  await until('the rail hides its tiles again', async () => !(await has(`rail-space-${personal.id}`)))
  await until('both projects listed', async () => (await has(`project-${alpha.id}`)) && (await has(`project-${beta.id}`)))
  console.log('spaces verify: ok')
} finally {
  await app?.close()
  client.close()
}
