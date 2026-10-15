import assert from 'node:assert/strict'
import { writeFileSync, unlinkSync, mkdirSync, rmdirSync } from 'node:fs'
import path from 'node:path'
import { connect, getClient, getState, refreshLists, resetClient } from '../src/state.ts'
import { openPreview, closePreview, previewState } from '../src/preview/store.ts'
import { until } from './dock-waits.ts'
assert.ok(process.env.KYBERN_DATA_DIR?.includes('gpuix-scratch') || process.env.KYBERN_DATA_DIR?.endsWith('/apps/gpuix/.combined/data'), 'Use an isolated scratch data directory')
connect()
await until(async () => getState().status === 'open', 'scratch connection')
await refreshLists()
const client = getClient()!, project = getState().projects.find(p => p.name === 'scratch-project')!
assert.ok(project)
const thread = await client.call('threads.create', { project_id: project.id, provider: { kind: 'claude-code', instance: 'default' }, title: 'Preview ticket verification' })
await refreshLists()
const file = path.join(project.path, `dock2-preview-${thread.id}.html`)
const folder = path.resolve(`dock2-preview-${thread.id}`)
mkdirSync(folder)
const outside = path.join(folder, 'index.html')
writeFileSync(file, '<!doctype html><h1>Local preview verification</h1>')
writeFileSync(outside, '<!doctype html><h1>Permission fixture</h1>')
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<!doctype html><h1>Proxy verification</h1>', { headers: { 'Content-Type': 'text/html' } }) })
try {
  await openPreview(thread.id, 'javascript:alert(1)', false, false)
  assert.ok(previewState(thread.id).error)
  await openPreview(thread.id, file, false, false)
  let state = previewState(thread.id)
  assert.equal(state.error, null); assert.equal(state.entries[0]?.kind, 'file'); assert.ok(state.entries[0]?.ticket)
  const fileURL = state.entries[0]!.url
  assert.ok((await (await fetch(fileURL)).text()).includes('Local preview verification'))
  await openPreview(thread.id, `http://127.0.0.1:${server.port}`, false, false)
  state = previewState(thread.id); assert.equal(state.entries[1]?.kind, 'server')
  assert.ok((await (await fetch(state.entries[1]!.url)).text()).includes('Proxy verification'))
  await openPreview(thread.id, outside, false, false)
  assert.ok(previewState(thread.id).permission, JSON.stringify({ error: previewState(thread.id).error, entry: previewState(thread.id).entries.at(-1) }))
  closePreview(thread.id)
  await until(async () => !(await fetch(fileURL)).ok, 'ticket revoked')
  assert.equal(previewState(thread.id).entries.length, 0)
  console.log('PASS preview rejection, local ticket, proxy, permission state, close/revoke')
} finally {
  closePreview(thread.id); server.stop(true); unlinkSync(file); unlinkSync(outside); rmdirSync(folder)
  await client.call('threads.archive', { thread_id: thread.id }); resetClient()
}
