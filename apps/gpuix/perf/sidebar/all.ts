/** One final quiet window for the scroll and fresh-daemon cold batches. */
for (const command of [
  ['bun', 'perf/sidebar/package.ts'],
  ['bun', 'perf/sidebar/final.ts', '--cold-fixture'],
  ['bun', 'perf/sidebar/fixture.ts', 'bun', 'perf/sidebar/final.ts'],
]) {
  const child = Bun.spawn(command, { env: process.env, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' })
  const stop = () => child.kill()
  process.on('SIGTERM', stop); process.on('SIGINT', stop)
  try { if (await child.exited) throw Error(command.join(' ') + ' failed') }
  finally { process.off('SIGTERM', stop); process.off('SIGINT', stop) }
}
export {}
