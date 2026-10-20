/** At-rest visual regression pair (lane gpuix-native): the same scenes captured with a control addon/env and with this
 * checkout's addon, both themes, OS window captures (Core Animation sublayers included), and the count of differing
 * pixels per scene. Motion changes may only differ while something moves; at rest the window must look the same.
 *
 *   bun perf/motion-native/rest-pair.ts <control.node> [--control-env K=V ...]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { seed } from '../bench/seed.ts'
import { lease } from '../bench/lease.ts'
import { requireScreen } from '../bench/screen-state.ts'
import { waitForWindowOnscreen, requireWindowOnscreen } from '../bench/window-onscreen.ts'
import { launchFixture } from '../../src/requests/harness.ts'
import { pngPixels } from '../../native/clip-pixels.ts'

const DATA = '/Users/mymac/projects/ade-gpuix-scratch/motion-native/bench'
const PORT = Number(process.env.MOTION_PORT ?? 4379)
const OUT = '/Users/mymac/projects/ade/previews/motion/native/rest-pair'
const root = path.resolve(import.meta.dir, '../..')
const argv = process.argv.slice(2)
const control = path.resolve(argv.shift() ?? '')
const controlEnv: Record<string, string> = {}
for (let i = argv.indexOf('--control-env'); i >= 0; i = argv.indexOf('--control-env')) { const [k, ...v] = argv[i + 1]!.split('='); controlEnv[k!] = v.join('='); argv.splice(i, 2) }
if (!existsSync(control)) throw Error('usage: rest-pair.ts <control.node> [--control-env K=V]')
mkdirSync(OUT, { recursive: true })
const fixture = await seed(DATA, PORT)
const manifest = fixture.manifest
const delay = (ms: number) => Bun.sleep(ms)
type Launch = Awaited<ReturnType<typeof launchFixture>>
const SCENES: Record<string, (c: (a: string, b?: object) => Promise<unknown>) => Promise<void>> = {
  home: async c => { await c('idle'); await c('home') },
  thread: async c => { await c('idle'); await c('open', { thread: manifest.long3000 }) },
}
const results: Record<string, unknown>[] = []
for (const theme of ['dark', 'light']) for (const [scene, open] of Object.entries(SCENES)) {
  const files: string[] = []
  for (const [variant, addon, env] of [['control', control, controlEnv], ['final', path.join(root, 'native/build/gpuix-native.darwin-arm64.node'), {}]] as const) {
    const release = await lease()
    let f: Launch | undefined
    try {
      const client = path.join(DATA, 'client', `rest-${variant}-${theme}-${scene}`); mkdirSync(client, { recursive: true })
      f = await launchFixture(path.join(root, 'perf/bench/app.ts'), {
        ...fixture.env, KYBERN_CLIENT_CONFIG_DIR: client, KYBERN_GPUIX_CREDENTIALS_DIR: path.join(client, 'credentials'), GPUIX_BACKGROUND: '1',
        KYBERN_PACING_IGNORE_PHYSICAL_MOUSE: '1', KYBERN_GPUIX_THREAD: '', KYBERN_APPEARANCE: theme, NAPI_RS_NATIVE_LIBRARY_PATH: addon, ...env,
      })
      const app = f.app
      await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
      const controlFile = path.join(client, 'bench-control.json')
      for (let i = 0; i < 400 && !existsSync(controlFile); i++) await delay(25)
      const port = JSON.parse(readFileSync(controlFile, 'utf8')).port
      const call = async (action: string, args: object = {}) => { const res = await fetch(`http://127.0.0.1:${port}`, { method: 'POST', body: JSON.stringify({ action, ...args }) }); if (!res.ok) throw Error(await res.text()) }
      await waitForWindowOnscreen(f.pid, 60_000)
      await open(call)
      const win = (await app.call('initialize', { protocolVersion: 1, client: 'rest-pair' })).window
      await app.mouse.move({ x: win.width - 4, y: win.height - 4 })
      await delay(2500)
      requireScreen(); requireWindowOnscreen(f.pid)
      const id = Number(/window (\d+) onscreen=true/.exec(Bun.spawnSync(['swift', path.join(root, 'perf/bench/window-onscreen.swift'), String(f.pid)]).stdout.toString())?.[1])
      const file = path.join(OUT, `${theme}-${scene}-${variant}.png`)
      Bun.spawnSync(['screencapture', '-x', '-o', '-l', String(id), file])
      files.push(file)
    } finally { await f?.close(); release() }
  }
  const [a, b] = files.map(pngPixels)
  let differ = 0
  if (a!.width === b!.width && a!.height === b!.height) for (let y = 0; y < a!.height; y++) for (let x = 0; x < a!.width; x++) { const p = a!.at(x, y), q = b!.at(x, y); if (p.some((v, i) => Math.abs(v - q[i]!) > 3)) differ++ }
  else differ = -1
  results.push({ theme, scene, differ, files })
  console.log(`${theme} ${scene}: ${differ} differing pixels`)
}
writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2))
await fixture.close()
fixture.remove()
