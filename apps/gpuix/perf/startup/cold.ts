/** Fresh daemon projection-cache startup, followed by two warm launches. */
import path from 'node:path'
const out = '/Users/mymac/projects/ade/previews/gpuix/perf/startup'
for (const phase of ['before', 'after']) {
  const bundle = phase === 'before' ? 'dist/Kybern GPUIX baseline.app' : 'dist/Kybern GPUIX.app'
  const child = Bun.spawn(['bun', 'perf/startup/fixture.ts', '--', 'bun', 'perf/startup/measure.ts', path.join(out, `${phase}-package-fresh.json`), '--packaged'], {
    env: { ...process.env, KYBERN_TEST_DAEMON: path.resolve(bundle, 'Contents/MacOS/kybernd'), KYBERN_STARTUP_EXECUTABLE: path.resolve(bundle, 'Contents/MacOS/Kybern GPUIX') }, stdout: 'ignore', stderr: 'inherit',
  })
  if (await child.exited) throw Error(`Fresh daemon package run failed: ${phase}`)
  console.log(`${phase}-package-fresh`)
}
