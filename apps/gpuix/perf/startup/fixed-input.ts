/** A lower offered rate avoids automation backpressure, so both versions
 * receive the same contact/decay packet trace during the resource window. */
import path from 'node:path'
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
const out = '/Users/mymac/projects/ade/previews/gpuix/perf/startup'
async function run(name: string, args: string[], extra: Record<string, string> = {}) {
  const child = Bun.spawn(['bun', 'perf/startup/measure.ts', path.join(out, name + '.json'), ...args], { env: { ...process.env, KYBERN_STARTUP_INPUT_HZ: '30', ...extra }, stdout: 'ignore', stderr: 'inherit' })
  if (await child.exited) throw Error(name + ' failed')
  if (args.includes('--active')) {
    const [result] = JSON.parse(readFileSync(path.join(out, name + '.json'), 'utf8'))
    const { packets, elapsed, maxOutstanding, samplePackets } = result.input
    if (maxOutstanding >= 32 || Math.abs(packets * 1000 / elapsed - 30) > 1.5 || samplePackets < 440 || samplePackets > 465) throw Error(`Unmatched offered input: ${name} ${JSON.stringify({ packets, elapsed, maxOutstanding, samplePackets })}`)
  }
  console.log(name)
}
const baseline = { KYBERN_STARTUP_EXECUTABLE: path.resolve('dist/Kybern GPUIX baseline.app/Contents/MacOS/Kybern GPUIX') }
await run('fixed-input-prewarm', ['--packaged', '--resources'])
for (let i = 0; i < 2; i++) for (const phase of i % 2 ? ['after', 'before'] : ['before', 'after']) await run(`${phase}-active-fixed-${i}`, ['--packaged', '--active'], phase === 'before' ? baseline : {})
const control = 'src/.startup-fixed-input-control.tsx'
if (existsSync(control)) throw Error('An import control already exists')
const source = readFileSync('src/main.tsx', 'utf8')
writeFileSync(control, source.replace("import { onWindowKeyDown }", "import { App } from './App.tsx'\nimport { onWindowKeyDown }").replace("const { App } = await import('./App.tsx')", ''))
try {
  for (const variant of ['static', 'dynamic']) await run(`control-${variant}-fixed`, ['--active'], { KYBERN_STARTUP_ENTRY: variant === 'static' ? control : 'src/main.tsx' })
} finally { rmSync(control) }
