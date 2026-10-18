import path from 'node:path'
const out = '/Users/mymac/projects/ade/previews/gpuix/perf/startup'
const label = process.argv[2]!
for (const [name, args, runs] of [
  ['idle-history', ['--resources', '--history'], '1'],
  ['package', ['--packaged'], '3'],
  ['package-idle', ['--packaged', '--resources'], '1'],
] as const) {
  const child = Bun.spawn(['bun', 'perf/startup/measure.ts', path.join(out, `${label}-${name}.json`), ...args], { env: { ...process.env, KYBERN_STARTUP_RUNS: runs }, stdout: 'ignore', stderr: 'inherit' })
  if (await child.exited) throw Error(`Startup suite failed: ${name}`)
}
const profile = Bun.spawn(['bun', 'perf/startup/profile.ts', path.join(out, `${label}-daemon.json`)], { stdout: 'ignore', stderr: 'inherit' })
if (await profile.exited) throw Error('Daemon diagnostic failed')
