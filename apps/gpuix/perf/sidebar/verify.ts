/** Separate real-window checks, each within one fair UI lease. */
for (const theme of ['dark', 'light']) for (const variant of ['baseline', 'candidate']) {
  const child = Bun.spawn(['bun', 'perf/sidebar/lease.ts', 'bun', 'perf/sidebar/run.ts', `${variant}-checks`], {
    env: { ...process.env, KYBERN_APPEARANCE: theme, SIDEBAR_CHECKS: '1', SIDEBAR_SCENE: 'mixed' },
    stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
  })
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => child.kill())
  if (await child.exited) throw Error(`${variant}/${theme} checks failed`)
}

export {}
