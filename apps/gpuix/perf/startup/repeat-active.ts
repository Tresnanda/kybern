import path from 'node:path'
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
const out = '/Users/mymac/projects/ade/previews/gpuix/perf/startup'
async function run(name: string, args: string[], baseline = false, extra: Record<string, string> = {}) {
  const child = Bun.spawn(['bun', 'perf/startup/measure.ts', path.join(out, name + '.json'), ...args], { env: { ...process.env, ...(baseline ? { KYBERN_STARTUP_EXECUTABLE: path.resolve('dist/Kybern GPUIX baseline.app/Contents/MacOS/Kybern GPUIX') } : {}), ...extra }, stdout: 'ignore', stderr: 'inherit' })
  if (await child.exited) throw Error(name + ' failed')
  console.log(name)
}
// Populate provider catalogs and transcript caches before the paired samples.
await run('matched-active-prewarm', ['--packaged', '--resources'])
for (let i = 0; i < 3; i++) for (const phase of i % 2 ? ['after', 'before'] : ['before', 'after']) await run(`${phase}-active-repeat-${i}`, ['--packaged', '--active'], phase === 'before')

// Equal-sized 2,000-turn threads that none of the warmup/scroll runs opened.
await run('before-open-cold', ['--packaged', '--open-thread'], true, { KYBERN_STARTUP_RUNS: '1' })
await run('after-open-cold', ['--packaged', '--open-thread'], false, { KYBERN_STARTUP_RUNS: '1', KYBERN_STARTUP_OTHER_THREAD: process.env.KYBERN_STARTUP_COLD_OTHER_THREAD! })

const control = 'src/.startup-active-control.tsx'
if (existsSync(control)) throw Error('An active import control already exists')
const source = readFileSync('src/main.tsx', 'utf8')
writeFileSync(control, source.replace("import { onWindowKeyDown }", "import { App } from './App.tsx'\nimport { onWindowKeyDown }").replace("const { App } = await import('./App.tsx')", ''))
try {
  for (const variant of ['static', 'dynamic']) {
    const child = Bun.spawn(['bun', 'perf/startup/measure.ts', path.join(out, `control-${variant}-active.json`), '--active'], { env: { ...process.env, KYBERN_STARTUP_ENTRY: variant === 'static' ? control : 'src/main.tsx' }, stdout: 'ignore', stderr: 'inherit' })
    if (await child.exited) throw Error(`Active ${variant} control failed`)
    console.log(`control-${variant}-active`)
  }
} finally { rmSync(control) }
