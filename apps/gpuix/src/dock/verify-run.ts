import { readFileSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
const data = path.resolve('../../.p5/gpuix-scratch/data')
const client = new KybernClient({ url: `ws://127.0.0.1:${readFileSync(`${data}/daemon.port`, 'utf8').trim()}/ws`, token: readFileSync(`${data}/daemon.token`, 'utf8').trim() })
client.connect()
while (client.status !== 'open') await Bun.sleep(30)
const project = (await client.call('projects.list', {})).projects[0] ?? await client.call('projects.add', { path: path.resolve('../../.p5/project'), name: 'scratch-project' })
const thread = await client.call('threads.create', { project_id: project.id, title: 'Dock verification', provider: { kind: 'claude-code', instance: 'default' }, model: 'claude-haiku-5-5' })
const runDir = mkdtempSync(path.join(data, '../run-'))
for (const file of ['daemon.port', 'daemon.token']) copyFileSync(path.join(data, file), path.join(runDir, file))
const child = Bun.spawn(process.argv.slice(2), { env: { ...process.env, KYBERN_DATA_DIR: runDir, KYBERN_CLIENT_CONFIG_DIR: path.join(runDir, 'config'), KYBERN_GPUIX_THREAD: thread.id, GPUIX_BACKGROUND: '1', NAPI_RS_NATIVE_LIBRARY_PATH: path.resolve('native/build/gpuix-native.darwin-arm64.node'), KYBERN_VERIFY_OUTPUT: '/Users/mymac/projects/ade/previews/gpuix/p5' }, stdout: 'inherit', stderr: 'inherit' })
const code = await child.exited
await client.call('threads.archive', { thread_id: thread.id })
rmSync(runDir, { recursive: true, force: true })
client.close(); process.exit(code)
