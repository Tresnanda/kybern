/** Debug: launch the tree app with the given env, open a bench thread, print painted text and save a screenshot.
 *   bun native/ui-lease.ts tree bun perf/tree/peek.ts <long3000|parent> <out.png> */
import { mkdirSync, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../../src/requests/harness.ts'
import { DATA, PORT, seedTree } from './seed.ts'
const [which, out] = process.argv.slice(2)
const fixture = await seedTree(DATA, PORT)
const client = path.join(DATA, 'client', 'peek'); mkdirSync(client, { recursive: true })
const f = await launchFixture(path.join(import.meta.dir, 'app.ts'), { ...fixture.env, KYBERN_CLIENT_CONFIG_DIR: client, KYBERN_GPUIX_CREDENTIALS_DIR: path.join(client, 'credentials'), KYBERN_BENCH_WHEEL_LIBRARY: path.join(DATA, 'bench-wheel.dylib'), KYBERN_GPUIX_THREAD: '', KYBERN_GPUIX_ENVIRONMENT: 'local', GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: 'dark', NAPI_RS_NATIVE_LIBRARY_PATH: path.resolve(import.meta.dir, '../../native/build/gpuix-native.darwin-arm64.node'), TREE_MANIFEST: path.join(DATA, 'tree-manifest.json') })
try {
  for (let i = 0; i < 400 && !existsSync(path.join(client, 'bench-control.json')); i++) await Bun.sleep(50)
  await Bun.sleep(1500)
  const port = JSON.parse(readFileSync(path.join(client, 'bench-control.json'), 'utf8')).port
  await fetch(`http://127.0.0.1:${port}`, { method: 'POST', body: JSON.stringify({ action: 'open', thread: which === 'parent' ? fixture.tree.parent : fixture.manifest.long3000 }) })
  await Bun.sleep(5000)
  console.log((await f.app.call('getPaintedText', {})).text.join('\n').slice(0, 1500))
  await f.app.screenshot({ path: out! })
} finally { await f.close(); await fixture.close() }
process.exit(0)
