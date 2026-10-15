// Real revision/conflict tests. This entry point refuses the real data directory.
import assert from 'node:assert/strict'
import { connect, getClient, getState, resetClient, subscribe } from '../state.ts'
import { load, save, flush } from '../shell/persist.ts'
import { NoteSession } from './session.ts'
import { splitBlocks } from './blocks.ts'

assert.equal(process.env.KYBERN_DATA_DIR, '/Users/mymac/projects/ade-gpuix-scratch/data')
for (const source of ['', '\n\n', '# Title\n\nBody\n', '```js\n\ncode\n```\n\nTail', 'a\r\n\r\nb\r\n', '~~~\n\n~~~\n\n', '    code\n\n    more\n']) assert.equal(splitBlocks(source).join(''), source)
connect()
await new Promise<void>((resolve) => { if (getState().status === 'open') return resolve(); const off = subscribe(() => { if (getState().status === 'open') { off(); resolve() } }) })
const client = getClient()!
const note = await client.call('notes.create', { scope: 'global', title: 'Notes session verification', body: 'first\nsecond\n' })
const key = `kybern.notes.draft:env:note:${note.id}`
const session = new NoteSession(note.id)
try {
  await session.reload()
  session.edit({ body: 'local first\nsecond\n' })
  await client.call('notes.update', { id: note.id, expected_revision: note.revision, body: 'first\nremote second\n' })
  await session.flush(); await session.flush()
  assert.equal((await client.call('notes.get', { id: note.id })).note!.body, 'local first\nremote second\n')
  console.log('PASS conservative non-overlapping remote merge')

  let latest = (await client.call('notes.get', { id: note.id })).note!
  session.edit({ body: 'mine\nremote second\n' })
  await client.call('notes.update', { id: note.id, expected_revision: latest.revision, body: 'theirs\nremote second\n' })
  await session.flush()
  assert.equal(session.getSnapshot().status, 'conflict')
  assert.equal(session.getSnapshot().body, 'mine\nremote second\n')
  assert.ok(load(key, null))
  session.keepMine(); await session.flush()
  assert.equal((await client.call('notes.get', { id: note.id })).note!.body, 'mine\nremote second\n')
  console.log('PASS overlapping conflict retains draft; Keep mine uses latest revision')

  latest = (await client.call('notes.get', { id: note.id })).note!
  session.edit({ body: 'local alternative\nremote second\n' })
  await client.call('notes.update', { id: note.id, expected_revision: latest.revision, body: 'remote alternative\nremote second\n' })
  await session.flush(); session.useTheirs()
  assert.equal(session.getSnapshot().body, 'remote alternative\nremote second\n')
  assert.equal(load(key, null), null)
  console.log('PASS Use theirs explicitly discards draft')

  session.edit({ body: 'a draft that outlives this session\n' })
  const recovered = new NoteSession(note.id)
  await recovered.reload()
  assert.equal(recovered.getSnapshot().body, 'a draft that outlives this session\n')
  await recovered.flush()
  console.log('PASS restored draft and exact trailing newline')

  // Delay the first update until a second edit arrives; no UI/unmount can drop it.
  const racing = new NoteSession(note.id)
  await racing.reload(); racing.attach()
  const call = client.call.bind(client)
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let hold = true
  client.call = (async (method: string, params: unknown) => { if (method === 'notes.update' && hold) { hold = false; await gate }; return call(method as never, params as never) }) as typeof client.call
  racing.edit({ body: 'first save\n' })
  const saving = racing.flush()
  racing.edit({ body: 'latest typing during save\n' })
  racing.detach(); release(); await saving; await racing.flush()
  client.call = call
  assert.equal((await client.call('notes.get', { id: note.id })).note!.body, 'latest typing during save\n')
  console.log('PASS typing during in-flight save + editor unmount')
  const retrying = new NoteSession(note.id)
  await retrying.reload(); retrying.attach()
  let failOnce = true
  client.call = (async (method: string, params: unknown) => { if (method === 'notes.update' && failOnce) { failOnce = false; throw new Error('Simulated network disconnect') }; return call(method as never, params as never) }) as typeof client.call
  retrying.edit({ body: 'Network recovery keeps this exact text.\n' })
  await retrying.flush()
  assert.equal(retrying.getSnapshot().status, 'error')
  assert.ok(load(key, null))
  await new Promise((resolve) => setTimeout(resolve, 1250))
  assert.equal((await client.call('notes.get', { id: note.id })).note!.body, 'Network recovery keeps this exact text.\n')
  retrying.detach(); client.call = call
  console.log('PASS failed network save retains draft and retries while mounted')
  // Clear an earlier session's scheduled edit without changing the saved note.
  await session.reload()
} finally {
  await session.flush()
  await client.call('notes.delete', { id: note.id }); await client.call('notes.purge', { id: note.id })
  save(key, undefined); flush(); resetClient()
}
