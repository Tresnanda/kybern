/** Two 15 s samples per workload; all RPCs use an in-memory fixture. */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { launch } from '@gpuix/react/automation'
import { pagesFixture } from './pages-fixture.ts'
const out = '/Users/mymac/projects/ade/previews/gpuix/pages'
mkdirSync(out, { recursive: true })
const fixture = pagesFixture()
const watchdog = setTimeout(() => process.exit(1), 240_000)
const app = await launch({ command: 'bun', args: [path.join(import.meta.dir, '../src/main.tsx')], env: { ...process.env, ...fixture.env, KYBERN_APPEARANCE: 'dark' } })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const log: string[] = []
const usageOnly = process.argv.includes('--usage-only')
async function sample(name: string, pid: number, interact?: (i: number) => Promise<void>) {
  for (let repeat = 1; repeat <= 2; repeat++) {
    const child = Bun.spawn(['bun', path.join(import.meta.dir, '../perf/sample.ts'), '15', `GPUIX=${pid}`], { stdout: 'pipe', stderr: 'pipe', env: process.env })
    let done = false
    const complete = child.exited.then(() => { done = true })
    if (interact) {
      for (let i = 0; !done; i++) { await interact(i); await sleep(700) }
    }
    await complete
    const text = `${name} run ${repeat}\n${await new Response(child.stdout).text()}`
    log.push(text); console.log(text)
    if (child.exitCode) throw new Error(await new Response(child.stderr).text())
  }
}
try {
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 20000 })
  await sleep(500)
  const init = await app.call('initialize', { protocolVersion: 1, client: 'pages-perf' })
  console.log(`Own GPUIX pid ${init.pid}`)
  await app.getByTestId('rail-usage').click()
  await app.getByTestId('usage-stats').waitFor({ timeoutMs: 10000 })
  await app.mouse.move({x:1200,y:40}); await sleep(1000)
  await sample('Usage idle: 30 bars, 2 breakdown rows', init.pid)
  await sample('Usage active: change grouping every 700ms', init.pid, async i => { await app.getByTestId(`usage-group-${i % 2 ? 'model' : 'provider'}`).click() })
  if (!usageOnly) {
  await app.getByTestId('rail-pulls').click()
  await app.getByTestId('pr-row-108').waitFor({ timeoutMs: 10000 })
  await app.getByTestId('pr-row-108').click()
  await app.getByTestId('pr-summary').waitFor({ timeoutMs: 10000 })
  await app.getByTestId('pr-tab-changes').click()
  await app.getByTestId('pr-native-diff').waitFor({ timeoutMs: 10000 })
  await app.mouse.move({x:1200,y:40}); await sleep(1000)
  await sample('Pull requests idle: 30 list rows, 30 files, 2400-line native diff', init.pid)
  await sample('Pull requests active: switch native diff files every 700ms', init.pid, async i => { await app.getByTestId(`pr-file-${i % 3}`).click() })
  }
  writeFileSync(`${out}/${usageOnly ? 'perf-usage-final' : 'perf'}.txt`, log.join('\n'))
} finally { clearTimeout(watchdog); await app.close(); fixture.close() }
