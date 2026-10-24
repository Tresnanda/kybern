// Drives the real window against a scratch daemon (`PORTING.md` "Daemon safety"):
//
//   KYBERN_DATA_DIR=<…gpuix-scratch…/data> KYBERN_VERIFY_OUTPUT=<dir> [KYBERN_APPEARANCE=light] bun src/spaces/default.verify.ts
//
// The default space: its tile menu disables Delete and says why, the daemon refuses a delete, and with one
// space the palette's "Rename space…" still reaches the editor. Also the sidebar's inline project rename.
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

const root = mkdtempSync(path.join(tmpdir(), 'gpuix-scratch-default-verify-'))
const folder = (name: string) => { const p = path.join(root, name); mkdirSync(p, { recursive: true }); return p }
const out = process.env.KYBERN_VERIFY_OUTPUT
const tag = process.env.KYBERN_APPEARANCE === 'light' ? 'light' : 'dark'

for (const space of (await client.call('spaces.list', {})).spaces.filter((s) => !s.is_default)) await client.call('spaces.delete', { space_id: space.id })
const personal = (await client.call('spaces.list', {})).spaces[0]!
assert.equal(personal.is_default, true)
const work = await client.call('spaces.create', { name: 'Work' })
assert.equal(work.is_default, false)
const alpha = await client.call('projects.add', { path: folder('alpha'), name: 'alpha', space_id: personal.id })

let app: App | undefined
const step = (message: string) => console.log(`- ${message}`)
const has = async (id: string) => (await app!.getByTestId(id).count()) > 0
const until = async (what: string, test: () => Promise<boolean>, ms = 8000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if (await test()) return; await Bun.sleep(80) }
  throw Error(`Timed out: ${what}`)
}
const shot = async (name: string) => { await Bun.sleep(450); if (out) await app!.screenshot({ path: path.join(out, name) }) }
const projectName = async () => (await client.call('projects.list', { refresh_git: false })).projects.find((p) => p.id === alpha.id)?.name

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
  await until('the rail tiles', () => has(`rail-space-${personal.id}`))

  step('the default space tile menu: Delete is disabled with a hint')
  await app.getByTestId(`rail-space-${personal.id}`).click({ button: 2 })
  await app.getByTestId('space-menu').waitFor()
  await shot(`tile-menu-default-${tag}.png`)
  await app.getByTestId('space-menu-delete').click()
  await Bun.sleep(300)
  assert.equal(await has('delete-space'), false, 'a disabled Delete opens no dialog')
  assert.equal((await client.call('spaces.list', {})).spaces.length, 2)
  await app.getByTestId('app-ready').press('escape')

  step('another space can still be deleted: its menu has Delete enabled')
  await app.getByTestId(`rail-space-${work.id}`).click({ button: 2 })
  await app.getByTestId('space-menu').waitFor()
  await shot(`tile-menu-other-${tag}.png`)
  await app.getByTestId('app-ready').press('escape')

  step('the daemon refuses to delete the default space')
  await assert.rejects(client.call('spaces.delete', { space_id: personal.id }), /Your default space can't be deleted\./)
  assert.equal((await client.call('spaces.list', {})).spaces.length, 2)

  step('inline project rename from the context menu')
  await until('alpha in the sidebar', () => has(`project-${alpha.id}`))
  await app.getByTestId(`project-${alpha.id}`).click({ button: 2 })
  await app.getByTestId('project-menu').waitFor()
  await shot(`project-menu-${tag}.png`)
  await app.getByTestId('project-menu-rename').click()
  await app.getByTestId(`rename-project-${alpha.id}`).waitFor()
  await app.getByTestId(`rename-project-${alpha.id}`).fill('Alpha renamed')
  await shot(`project-rename-${tag}.png`)
  await app.getByTestId(`rename-project-${alpha.id}`).press('enter')
  await until('the daemon has the new name', async () => (await projectName()) === 'Alpha renamed')
  await until('the field closed', async () => !(await has(`rename-project-${alpha.id}`)))
  await until('the row is still there', () => has(`project-${alpha.id}`))

  step('Esc cancels, an empty name cancels')
  await app.getByTestId(`project-${alpha.id}`).click({ button: 2 })
  await app.getByTestId('project-menu-rename').click()
  await app.getByTestId(`rename-project-${alpha.id}`).fill('Nope')
  await app.getByTestId(`rename-project-${alpha.id}`).press('escape')
  await until('the field closed', async () => !(await has(`rename-project-${alpha.id}`)))
  await app.getByTestId(`project-${alpha.id}`).click({ button: 2 })
  await app.getByTestId('project-menu-rename').click()
  await app.getByTestId(`rename-project-${alpha.id}`).fill('   ')
  await app.getByTestId(`rename-project-${alpha.id}`).press('enter')
  await until('the field closed', async () => !(await has(`rename-project-${alpha.id}`)))
  await Bun.sleep(400)
  assert.equal(await projectName(), 'Alpha renamed')

  step('one space: the palette renames it')
  await client.call('spaces.delete', { space_id: work.id })
  await until('the rail hides its tiles', async () => !(await has(`rail-space-${personal.id}`)))
  await app.getByTestId('sidebar-search').click()
  await app.getByTestId('palette-input').waitFor()
  step('palette open')
  await app.getByTestId('palette-input').fill('rename')
  step('palette filled')
  await until('both rename commands', async () => (await has('palette-item-space-rename')) && (await has('palette-item-project-rename')))
  await shot(`palette-${tag}.png`)
  await app.getByTestId('palette-item-space-rename').click()
  await app.getByTestId('space-editor').waitFor()
  await app.getByTestId('space-name').fill('Home base')
  await shot(`space-editor-single-${tag}.png`)
  await app.getByTestId('space-save').click()
  await until('renamed, still the default', async () => {
    const [only] = (await client.call('spaces.list', {})).spaces
    return only?.name === 'Home base' && only.is_default === true
  })

  console.log('default space verify: ok')
} finally {
  await app?.close()
  client.close()
}
