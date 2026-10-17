/** Measure the same Settings workload twice; never changes daemon settings. */
import { execFileSync, spawn } from 'node:child_process'
import path from 'node:path'
import { launch } from '@gpuix/react/automation'

if (!process.env.KYBERN_DATA_DIR?.includes('gpuix-scratch')) throw new Error('Use the scratch daemon')
const main = path.join(import.meta.dir, '../src/main.tsx')
const app = await launch({ command: 'bun', args: [main], env: { ...process.env, GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: 'dark' } })
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
let sampler: ReturnType<typeof spawn> | undefined
try {
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 60000 })
  await wait(1500)
  await app.getByTestId('rail-settings').click()
  await app.getByTestId('settings-worktrees').waitFor()
  await wait(3000)
  const row = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n').find((line) => line.trim().endsWith(`bun ${main}`))
  if (!row) throw new Error('Cannot find this check’s app process')
  const pid = row.trim().split(/\s+/)[0]
  const sample = (label: string) => {
    console.log(label)
    const child = sampler = spawn('bun', [path.join(import.meta.dir, '../perf/sample.ts'), '15', `GPUIX=${pid}`], { stdio: 'inherit' })
    return new Promise<void>((resolve, reject) => child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`sample exited ${code}`))))
  }
  for (let run = 1; run <= 2; run++) {
    await app.getByTestId('settings-tab-general').click()
    await wait(800)
    await sample(`Idle General, run ${run}`)
    const sampling = sample(`Active nav + search + menu, run ${run}`)
    for (let i = 0; i < 10; i++) {
      await app.getByTestId('settings-tab-appearance').click()
      await wait(220)
      await app.getByTestId('settings-tab-general').click()
      await wait(220)
      await app.getByTestId('settings-permissions').click()
      await wait(220)
      await app.getByTestId('settings-permissions-menu').press('escape')
      await app.getByTestId('settings-search').fill(i % 2 ? '' : 'theme')
      await wait(220)
      await app.getByTestId('settings-search').fill('')
    }
    await sampling
  }
} finally { if (sampler && sampler.exitCode === null) sampler.kill(); await app.close() }
