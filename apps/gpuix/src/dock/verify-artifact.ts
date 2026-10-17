import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import { until } from '../../scripts/dock-waits.ts'
const data = process.env.KYBERN_DATA_DIR!, thread = process.env.KYBERN_GPUIX_THREAD!
assert.ok(data.includes('gpuix-scratch'))
const port = readFileSync(`${data}/daemon.port`, 'utf8').trim()
const client = new KybernClient({ url: `ws://127.0.0.1:${port}/ws`, token: readFileSync(`${data}/daemon.token`, 'utf8').trim() }); client.connect()
await until(async () => client.status === 'open', 'scratch connection')
const file = path.resolve('../../.p5/project/p5-artifact.html')
writeFileSync(file, '<!doctype html><h1>HTML artifact lifecycle</h1><script>document.body.dataset.ready="yes"</script>')
try {
 const { ticket } = await client.call('threads.artifacts.preview', { thread_id: thread, path: file })
 const url = `http://127.0.0.1:${port}/artifact-preview/${ticket}`
 const response = await fetch(url)
 assert.equal(response.status, 200)
 assert.ok((response.headers.get('content-security-policy') ?? '').includes('sandbox allow-scripts'))
 assert.ok((await response.text()).includes('HTML artifact lifecycle'))
 assert.equal((await fetch(url)).status, 404, 'artifact ticket is single use')
 console.log('PASS HTML artifact served with sandbox CSP and single-use ticket')
} finally { unlinkSync(file); client.close() }
