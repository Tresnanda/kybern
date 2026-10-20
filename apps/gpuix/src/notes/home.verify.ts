// Isolated two-daemon routing regression. Never reads the user's daemon or Keychain.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
const root = mkdtempSync(path.join(tmpdir(), 'gpuix-scratch-note-home-'))
const processes: ReturnType<typeof spawn>[] = []
const clients: KybernClient[] = []
async function until(test: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 15000
  while (!await test()) { if (Date.now() > deadline) throw Error('Timed out'); await Bun.sleep(50) }
}
try {
  for (const name of ['home', 'remote']) {
    const data = path.join(root, name); mkdirSync(data)
    processes.push(spawn('/Applications/kybern.app/Contents/MacOS/kybernd', ['--data-dir', data, '--port', '0'], { stdio: 'ignore' }))
    await until(() => existsSync(path.join(data, 'daemon.port')))
    const client = new KybernClient({ url: `ws://127.0.0.1:${readFileSync(path.join(data, 'daemon.port'), 'utf8').trim()}/ws`, token: readFileSync(path.join(data, 'daemon.token'), 'utf8').trim() })
    clients.push(client); client.connect(); await until(() => client.status === 'open')
  }
  const [home, remote] = clients as [KybernClient, KybernClient]
  const localNote = await home.call('notes.create', { scope: 'global', title: 'Shared from home', body: 'Home body' })
  const remoteNote = await remote.call('notes.create', { scope: 'global', title: 'Separate remote', body: 'Remote body' })
  const config = path.join(root, 'config'), credentials = path.join(root, 'credentials')
  mkdirSync(config); mkdirSync(credentials)
  writeFileSync(path.join(config, 'environments.json'), JSON.stringify({ selected_id: 'remote', environments: [{ id: 'remote', name: 'Remote scratch', local: false, url: remote.endpoint.url }] }))
  writeFileSync(path.join(credentials, 'remote.token'), remote.endpoint.token, { mode: 0o600 })
  process.env.KYBERN_DATA_DIR = path.join(root, 'home')
  process.env.KYBERN_CLIENT_CONFIG_DIR = config
  process.env.KYBERN_GPUIX_CREDENTIALS_DIR = credentials
  process.env.KYBERN_GPUIX_ENVIRONMENT = 'remote'
  delete process.env.KYBERN_URL; delete process.env.KYBERN_TOKEN
  const state = await import('../state.ts')
  const store = await import('./store.ts')
  const policy = await import('./home.ts')
  state.connect(); await until(() => state.getState().status === 'open')
  await store.refreshNotes()
  await until(async () => { await store.refreshNotes(); return store.getNotes().notes.some((note) => note.id === localNote.id) })
  assert(!store.getNotes().notes.some((note) => note.id === remoteNote.id))
  assert.equal((await store.rpc(localNote.id).call('notes.get', { id: localNote.id })).note?.body, 'Home body')
  const created = await store.createNote('Created at home', 'Shared creation', '')
  assert(created)
  assert((await home.call('notes.get', { id: created.id })).note)
  await assert.rejects(remote.call('notes.get', { id: created.id }))
  assert((await store.searchNotes('Shared')).some((note) => note.id === localNote.id))
  const project = await remote.call('projects.add', { path: root, name: 'Remote scratch project' })
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=', 'base64')
  const upload = await fetch(home.endpoint.url.replace('ws:', 'http:').replace('/ws', '/assets'), { method: 'POST', headers: { authorization: `Bearer ${home.endpoint.token}`, 'content-type': 'image/png', 'x-kybern-filename': 'test.png' }, body: png })
  const asset = await upload.json() as { id: string }
  await home.call('notes.update', { id: created.id, expected_revision: created.revision, body: `![Tiny image](kybern://asset/${asset.id})` })
  const moved = await store.moveNote(created.id, project.id)
  assert((await home.call('notes.get', { id: created.id })).note?.deleted_at)
  const movedNote = (await remote.call('notes.get', { id: moved })).note!
  assert.equal(movedNote.project_id, project.id)
  const movedAsset = /kybern:\/\/asset\/([a-f\d-]{36})/.exec(movedNote.body)![1]!
  assert((await fetch(remote.endpoint.url.replace('ws:', 'http:').replace('/ws', `/assets/${movedAsset}`), { headers: { authorization: `Bearer ${remote.endpoint.token}` } })).ok)
  let policyChanges = 0
  const unsubscribe = policy.onGlobalNotesHomeChange(() => policyChanges++)
  policy.setGlobalNotesHome('separate'); await store.refreshNotes()
  assert.equal(policyChanges, 1)
  unsubscribe()
  assert(store.getNotes().notes.some((note) => note.id === remoteNote.id))
  assert(!store.getNotes().notes.some((note) => note.id === localNote.id))
  assert.equal((await home.call('notes.get', { id: localNote.id })).note?.body, 'Home body')
  assert.equal((await remote.call('notes.get', { id: remoteNote.id })).note?.body, 'Remote body')
  state.resetClient()
  console.log('PASS shared/separate routing, home creation, cross-daemon move, and non-destructive preference switching')
} finally {
  clients.forEach((client) => client.close())
  for (const child of processes) { child.kill(); await new Promise<void>((resolve) => child.exitCode !== null ? resolve() : child.once('exit', () => resolve())) }
  rmSync(root, { recursive: true, force: true })
}
