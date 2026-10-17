// bun src/terminal/mkthread.ts <title>: creates an empty thread in the scratch daemon (KYBERN_DATA_DIR) and prints its id.
import { readFileSync } from 'node:fs'
import { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
const data = process.env.KYBERN_DATA_DIR!
if (!data?.includes('gpuix-scratch')) throw new Error('KYBERN_DATA_DIR must be a gpuix-scratch folder')
const port = readFileSync(`${data}/daemon.port`, 'utf8').trim(), token = readFileSync(`${data}/daemon.token`, 'utf8').trim()
const client = new KybernClient({ url: `ws://127.0.0.1:${port}/ws`, token }, { createSocket: (url, key) => new WebSocket(url, { headers: { origin: 'tauri://localhost', Authorization: `Bearer ${key}` } } as unknown as string[]) })
await new Promise<void>(resolve => { client.onStatus(s => { if (s === 'open') resolve() }); client.connect() })
const project = (await client.call('projects.list', {})).projects.find(p => p.name === 'scratch-project')!
const thread = await client.call('threads.create', { project_id: project.id, title: process.argv[2]!, provider: { kind: 'claude-code', instance: 'default' }, model: 'claude-haiku-5-5' })
console.log(thread.id)
process.exit(0)
