import path from 'node:path'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
const out = '/Users/mymac/projects/ade/previews/gpuix/perf/startup'
async function measure(name: string, args: string[] = [], env: Record<string, string> = {}) {
  const child = Bun.spawn(['bun', 'perf/startup/measure.ts', path.join(out, `${name}.json`), ...args], { env: { ...process.env, ...env }, stdout: 'ignore', stderr: 'inherit' })
  if (await child.exited) throw Error(`Measurement failed: ${name}`)
  console.log(name)
}
await measure('after-dev')
await measure('before-open', ['--packaged', '--open-thread'], { KYBERN_STARTUP_EXECUTABLE: path.resolve('dist/Kybern GPUIX baseline.app/Contents/MacOS/Kybern GPUIX') })
await measure('after-open', ['--packaged', '--open-thread'])
await measure('after-package', ['--packaged'])
await measure('after-idle-history', ['--resources', '--history'])
await measure('after-package-idle', ['--packaged', '--resources'])
await measure('before-active', ['--packaged', '--active'], { KYBERN_STARTUP_EXECUTABLE: path.resolve('dist/Kybern GPUIX baseline.app/Contents/MacOS/Kybern GPUIX') })
await measure('after-active', ['--packaged', '--active'])
const control = 'src/.startup-import-control.tsx'
if (existsSync(control)) throw Error('An import control already exists; refusing to overwrite it')
const source = readFileSync('src/main.tsx', 'utf8')
const eager = source.replace("import { onWindowKeyDown }", "import { App } from './App.tsx'\nimport { onWindowKeyDown }").replace("const { App } = await import('./App.tsx')", '')
if (eager === source || eager.includes("const { App } = await import('./App.tsx')")) throw Error('Static import control anchors changed')
writeFileSync(control, eager)
try {
  await measure('control-static-import', [], { KYBERN_STARTUP_ENTRY: control })
  await measure('control-static-idle', ['--resources'], { KYBERN_STARTUP_ENTRY: control })
}
finally { rmSync(control) }
for (const prefetch of ['0', '1']) await measure(`history-120ms-prefetch-${prefetch}`, ['--history'], { KYBERN_HISTORY_PREFETCH: prefetch, KYBERN_STARTUP_HISTORY_DELAY_MS: '120', KYBERN_STARTUP_RUNS: '2' })
const assets = Bun.spawn(['bun', 'perf/startup/assets.ts', out, 'after'], { stdout: 'ignore', stderr: 'inherit' })
if (await assets.exited) throw Error('Visual capture failed')
const profile = Bun.spawn(['bun', 'perf/startup/profile.ts', path.join(out, 'after-daemon.json')], { stdout: 'ignore', stderr: 'inherit' })
if (await profile.exited) throw Error('Daemon profile failed')
