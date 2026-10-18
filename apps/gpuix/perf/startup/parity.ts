import path from 'node:path'
const out = '/Users/mymac/projects/ade/previews/gpuix/perf/startup'
for (const phase of ['before', 'after']) for (const appearance of ['dark', 'light']) {
  const child = Bun.spawn(['bun', 'perf/startup/measure.ts', path.join(out, `${phase}-settled-${appearance}.json`), '--packaged', '--visuals'], { env: { ...process.env, KYBERN_STARTUP_EXECUTABLE: path.resolve(phase === 'before' ? 'dist/Kybern GPUIX baseline.app/Contents/MacOS/Kybern GPUIX' : 'dist/Kybern GPUIX.app/Contents/MacOS/Kybern GPUIX'), KYBERN_APPEARANCE: appearance, KYBERN_STARTUP_VISUAL_SETTLE_MS: '20000' }, stdout: 'ignore', stderr: 'inherit' })
  if (await child.exited) throw Error(`${phase} ${appearance} failed`)
  console.log(`${phase}-settled-${appearance}`)
}
