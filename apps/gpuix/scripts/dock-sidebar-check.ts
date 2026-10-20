/** Scratch-only sidebar split actions, including placement and duplicate prevention. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { KybernClient } from '../../../packages/kybern-client/src/client.ts'
import { launchFixture } from '../src/requests/harness.ts'
import { until } from './dock-waits.ts'

const data = process.env.KYBERN_DATA_DIR!
assert.ok(data?.includes('gpuix-scratch'))
const client = new KybernClient({ url: `ws://127.0.0.1:${readFileSync(path.join(data, 'daemon.port'), 'utf8').trim()}/ws`, token: readFileSync(path.join(data, 'daemon.token'), 'utf8').trim() })
client.connect()
await until(async () => client.status === 'open', 'scratch connection')
const { thread: parent } = await client.call('threads.get', { thread_id: process.env.KYBERN_GPUIX_THREAD! })
const created: string[] = []
let fixture: Awaited<ReturnType<typeof launchFixture>> | undefined
try {
  for (const title of ['Right split fixture', 'Below split fixture']) {
    const thread = await client.call('threads.create', { project_id: parent.project_id, provider: parent.provider, title })
    created.push(thread.id)
  }
  fixture = await launchFixture(path.resolve('src/main.tsx'), { GPUIX_BACKGROUND: '1', KYBERN_REDUCED_MOTION: '1' })
  const app = fixture.app
  await app.getByTestId('header-title').waitFor({ timeoutMs: 60000 })
  const headers = async () => {
    const tree = (await app.call('getTree', {})).tree
    const ids: string[] = []
    const visit = (node: typeof tree) => { if (!node) return; if (node.testId?.startsWith('pane-header-')) ids.push(node.testId); for (const child of node.children ?? []) visit(child) }
    visit(tree)
    return Promise.all(ids.map(async id => ({ text: await app.getByTestId(id).textContent(), bounds: await app.getByTestId(id).bounds() })))
  }
  for (const [i, label] of ['Open to the right', 'Open below'].entries()) {
    await app.getByTestId(`thread-${created[i]}`).click({ button: 2 })
    await app.getByText(label).click()
    await until(async () => (await headers()).length === i + 2, label)
  }
  const panes = await headers()
  const right = panes.find(p => p.text.includes('Right split fixture'))!
  const below = panes.find(p => p.text.includes('Below split fixture'))!
  const original = panes.find(p => p.text.includes(parent.title))!
  assert.ok(right && below && original)
  assert.ok(right.bounds.x > original.bounds.x, 'Right action creates the right pane')
  assert.ok(below.bounds.y > right.bounds.y, 'Below action creates the bottom pane')
  assert.ok(Math.abs(below.bounds.x - right.bounds.x) < 2, 'Bottom pane stays in the right column')
  await app.getByTestId(`thread-${created[0]}`).click({ button: 2 })
  await app.getByText('Open to the right').click()
  assert.equal((await headers()).length, 3, 'Already open thread cannot be duplicated')
  console.log('PASS sidebar right/below split placement and duplicate prevention')
} finally {
  await fixture?.close()
  for (const thread_id of created) await client.call('threads.archive', { thread_id })
  client.close()
}
