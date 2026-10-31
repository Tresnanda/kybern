// Run through ego-browser nodejs; see network/README.md for the complete scratch workflow.
export async function benchmark(root, coldTransforms = false) {
  const { readFile, writeFile } = await import('node:fs/promises')
  const info = JSON.parse(await readFile(root + '/forwards.json', 'utf8'))
  const task = await taskSpace('Port forwarding benchmark')
  const page = task.page('p1')
  await page.cdp('Network.enable')
  await page.cdp('Network.setCacheDisabled', { cacheDisabled: true })
  await page.cdp('Page.addScriptToEvaluateOnNewDocument', { source: 'performance.setResourceTimingBufferSize(1000)' })
  const modes = ['direct', 'tcp', 'tunnel'], loads = [], updates = []
  let version = Date.now()
  for (let round = -1; round < 12; round++) {
    const start = (round + 3) % 3
    for (const mode of modes.slice(start).concat(modes.slice(0, start))) {
      if (coldTransforms) await fetch(`http://127.0.0.1:${info.direct}/__bench/cold`, { method: 'POST' })
      await page.goto(`http://localhost:${info[mode]}/?round=${round}`)
      await page.waitForFunction(() => window.appReady > 0)
      const ms = await page.evaluate(() => window.appReady)
      if (round >= 0) loads.push({ mode, ms })
    }
  }
  for (const mode of modes) {
    await page.goto(`http://localhost:${info[mode]}/?hmr=1`)
    await page.waitForFunction(() => window.appReady > 0)
    await page.waitForTimeout(500)
    const samples = await page.evaluate(async offset => {
      const results = []
      for (let i = 0; i < 30; i++) {
        await new Promise(resolve => setTimeout(resolve, 100))
        const version = offset + i, started = performance.now()
        await fetch('/__bench/change?version=' + version, { method: 'POST' })
        const deadline = performance.now() + 5000
        while (window.hmrVersion !== version) {
          if (performance.now() > deadline) throw Error('HMR timed out')
          await new Promise(resolve => setTimeout(resolve, 1))
        }
        results.push(window.hmrAppliedAt - started)
      }
      return results
    }, version)
    version += 1000
    updates.push(...samples.map(ms => ({ mode, ms })))
  }
  const median = values => { const sorted = values.sort((a,b) => a-b), middle = sorted.length >> 1; return sorted.length % 2 ? sorted[middle] : (sorted[middle-1]+sorted[middle])/2 }
  const summary = Object.fromEntries(modes.map(mode => [mode, {
    first_load_ms: median(loads.filter(x => x.mode === mode).map(x => x.ms)),
    hmr_ms: median(updates.filter(x => x.mode === mode).map(x => x.ms)),
  }]))
  await writeFile(root + '/browser-results.json', JSON.stringify({ summary, open_ms: info.open_ms, loads, updates }, null, 2))
  await writeFile(root + '/done', '')
  console.log({ summary, open_ms: info.open_ms })
  await task.finish({ keep: [] })
}
