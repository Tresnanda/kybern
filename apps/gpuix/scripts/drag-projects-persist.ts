/** Drag a project below its neighbour, restart the app, and assert the new order persisted. Scratch only. */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { launch } from '@gpuix/react/automation'
import { connect } from '../visual/fixture.ts'

const data = process.env.KYBERN_DATA_DIR!
if (!data?.includes('gpuix-scratch')) throw new Error('Scratch daemon required')
const client = await connect({ daemonPid: 0, port: Number(readFileSync(path.join(data, 'daemon.port'), 'utf8').trim()), token: readFileSync(path.join(data, 'daemon.token'), 'utf8').trim(), seeded: true })
const projects = (await client.call('projects.list', {})).projects
const id = (n: string) => projects.find((p) => p.name === n)!.id
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const env = () => ({ GPUIX_BACKGROUND: '1', KYBERN_DATA_DIR: data, KYBERN_APPEARANCE: 'dark', ...(process.env.KYBERN_REDUCED_MOTION ? { KYBERN_REDUCED_MOTION: process.env.KYBERN_REDUCED_MOTION } : {}), NAPI_RS_NATIVE_LIBRARY_PATH: process.env.NAPI_RS_NATIVE_LIBRARY_PATH! })
const start = async () => { const app = await launch({ command: 'bun', args: [path.resolve('src/main.tsx')], env: env() }); await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 }); await sleep(2500); return app }
const names = ['alpha-app', 'beta-docs', 'gamma-cli', 'delta-api', 'epsilon-web']
// Rows below the fold are virtualized away: order only the projects that are painted.
const order = async (app: Awaited<ReturnType<typeof start>>) => (await Promise.all(names.map(async (n) => [n, await app.getByTestId(`project-${id(n)}`).bounds().then((b) => b.y, () => null)] as const))).flatMap(([n, y]) => (y == null ? [] : [[n, y] as const])).sort((a, b) => a[1] - b[1]).map(([n]) => n)
writeFileSync(path.join(data, 'gpuix-ui.json'), '{}')
let app = await start()
const before = await order(app)
const top = before[0]!, second = before[1]!
const a = await app.getByTestId(`project-${id(top)}`).center()
const b = await app.getByTestId(`project-${id(second)}`).bounds()
await app.mouse.move(a); await app.mouse.down(a)
for (let i = 1; i <= 30; i++) { await app.mouse.move({ x: a.x, y: a.y + ((b.y + b.height + 40 - a.y) * i) / 30 }, { pressedButton: 0 }); await sleep(12) }
await sleep(200); await app.mouse.up({ x: a.x, y: b.y + b.height + 40 }); await sleep(900)
const after = await order(app)
assert.equal(after.indexOf(top) > after.indexOf(second), true, `drag did not reorder: ${before} -> ${after}`)
await app.close(); await sleep(1500)
app = await start()
const reloaded = await order(app)
assert.deepEqual(reloaded, after, `order not persisted: ${after} -> ${reloaded}`)
await app.close()
console.log('PASS project reorder persists', before.join(','), '->', reloaded.join(','))
client.close?.(); process.exit(0)
