// Screenshots of the first-run flow in a real window, against a fresh scratch daemon (dev aid for `onboarding-perf.ts`).
//   bun scripts/onboarding-shot.ts <out.png> [--scene agents|projects|prefs] [--theme dark|light] [--wait ms] [--click testId ...]
import '../src/native/local-build.ts'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchFixture } from '../src/requests/harness.ts'

const argv = process.argv.slice(2)
const flag = (name: string, fallback: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1]! : fallback)
const outFile = path.resolve(argv[0] ?? 'onboarding.png')
const clicks = argv.flatMap((a, i) => (a === '--click' ? [argv[i + 1]!] : []))
const repo = path.resolve(import.meta.dir, '../../..')
const dir = path.join(process.env.BENCH_SCRATCH ?? path.join(tmpdir(), 'kybern-onboarding-bench'), `shot-${process.pid}`)
const port = Number(process.env.BENCH_PORT ?? 4391)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
rmSync(dir, { recursive: true, force: true }); mkdirSync(path.join(dir, 'data'), { recursive: true })
const env = { ...process.env }; delete env.KYBERN_URL; delete env.KYBERN_TOKEN
const daemon = spawn(path.join(repo, 'target', 'debug', 'kybernd'), ['--data-dir', path.join(dir, 'data'), '--port', String(port)], { env, stdio: 'ignore' })
for (let i = 0; i < 100 && !existsSync(path.join(dir, 'data', 'daemon.port')); i++) await sleep(100)
await sleep(300)
const scene = flag('--scene', '')
const f = await launchFixture(path.join(import.meta.dir, '..', 'src/main.tsx'), {
  GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: flag('--theme', 'dark'), KYBERN_WINDOW_SIZE: flag('--size', '1440x900'), KYBERN_ONBOARDING: '1',
  ...(scene ? { KYBERN_ONBOARDING_SCENE: scene } : {}),
  KYBERN_DATA_DIR: path.join(dir, 'data'), KYBERN_CLIENT_CONFIG_DIR: path.join(dir, 'client'), KYBERN_GPUIX_CREDENTIALS_DIR: path.join(dir, 'credentials'), KYBERN_URL: '', KYBERN_TOKEN: '',
})
try {
  await sleep(Number(flag('--wait', '5000')))
  for (const id of clicks) {
    if (id.startsWith('wait:')) { await sleep(Number(id.slice(5))); continue }
    const c = await f.app.getByTestId(id).center(); await f.app.mouse.click(c); await sleep(Number(flag('--gap', '1500')))
  }
  await f.app.screenshot({ path: outFile })
  console.log(outFile)
} finally {
  await f.close(); daemon.kill()
  // The window may have started or restarted a daemon of its own for this data dir; it outlives the window.
  spawnSync('pkill', ['-f', `kybernd.*${path.join(dir, "data")}`])
  rmSync(dir, { recursive: true, force: true })
}
