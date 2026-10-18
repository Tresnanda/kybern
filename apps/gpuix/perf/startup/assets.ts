import path from 'node:path'
const out = process.argv[2]!, label = process.argv[3]!
for (const theme of ['dark', 'light']) {
  const child = Bun.spawn(['bun', 'perf/startup/measure.ts', path.join(out, `${label}-${theme}.json`), '--visuals'], { env: { ...process.env, KYBERN_APPEARANCE: theme }, stdout: 'ignore', stderr: 'inherit' })
  if (await child.exited) throw Error(`Visual capture failed: ${theme}`)
}
