// Fresh live-clock window. Never take a native screenshot or change its clock.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../src/requests/harness.ts'
import { until, openDock, absent } from './dock-waits.ts'
import { summarize } from '../src/drag/pacing.ts'
const data = '/Users/mymac/projects/ade-gpuix-scratch/round7-dock7b'
const out = '/Users/mymac/projects/ade/previews/gpuix/round7/dock7b'
const fixture = JSON.parse(readFileSync(`${data}/dock7-fixture.json`, 'utf8'))
const profile = process.env.DOCK7B_PROFILE === '1'
const suffix = process.env.DOCK7B_LABEL ?? (profile ? '-profile' : process.env.DOCK7B_BASELINE === '1' ? '-baseline' : '')
for (const theme of ['dark', 'light']) {
  writeFileSync(`${data}/gpuix-ui.json`, '{}')
  const run = await launchFixture(path.resolve(profile ? 'scripts/dock7b-profile-app.ts' : 'src/main.tsx'), { GPUIX_BACKGROUND: '1', KYBERN_FULL_RATE: '1', KYBERN_DATA_DIR: data, KYBERN_GPUIX_THREAD: fixture.thread, KYBERN_CLIENT_CONFIG_DIR: `${data}/perf-${theme}`, KYBERN_GPUIX_CREDENTIALS_DIR: `${data}/credentials`, KYBERN_APPEARANCE: theme, KYBERN_REDUCED_MOTION: '0', KYBERN_OPAQUE: '1', KYBERN_FRAME_TIMES: '1', ...(profile ? { KYBERN_DEBUG_ISLANDS: '1' } : {}) })
  const app = run.app
  try {
    await app.getByTestId('header-title').waitFor({ timeoutMs: 60000 })
    console.log('perf', theme, 'header ready')
    if (!await app.getByTestId('right-dock').count()) await app.getByTestId('app-ready').press('cmd-j')
    await openDock(app.getByTestId('right-dock'))
    await app.getByTestId('dock-add').click(); await app.getByTestId('dock-add-explorer').click()
    console.log('perf', theme, 'Explorer opened')
    const last = app.getByTestId('dock-file-README.md')
    await until(async () => Math.abs((await last.bounds()).y - 252.5) < 0.01, 'root rows settle', 10000)
    const closedY = (await last.bounds()).y
    for (const [folder, child, count] of [['src', 'src/components', 3], ['src/components', 'src/components/kit', 6], ['src/components/kit', 'src/components/kit/theme.ts', 8]] as const) {
      await app.getByTestId(`dock-file-${folder}`).click()
      await app.getByTestId(`dock-file-${child}`).waitFor({ timeoutMs: 15000 })
      await until(async () => Math.abs((await last.bounds()).y - closedY - count * 29) < 1, `loaded branch ${folder} settles`, 10000)
      console.log('perf', theme, 'loaded', child)
    }
    const openY = closedY + 8 * 29
    await until(async () => Math.abs((await last.bounds()).y - openY) < 1, 'nested branch settles', 10000)
    await app.getByTestId('dock-file-src').click(); await absent(app.getByTestId('dock-file-src/components')); await until(async () => Math.abs((await last.bounds()).y - closedY) < 0.1, 'collapse settles', 10000)
    const traceStart = Number([...run.diagnostics().matchAll(/\[kybern-frame\] ([\d.]+)/g)].at(-1)?.[1] ?? 0)
    console.log('[dock7b-workload-start]', theme, run.pid)
    const sampler = profile ? Bun.spawn(['/usr/bin/sample', String(run.pid), '2', '1', '-file', `${out}/native-profile-${theme}.txt`], { stdout: 'ignore', stderr: 'ignore' }) : null
    for (let n = 0; n < (profile ? 20 : 8); n++) {
      await app.getByTestId('dock-file-src').click()
      await until(async () => Math.abs((await last.bounds()).y - openY) < 1, 'live expand', 10000)
      await app.getByTestId('dock-file-src').click()
      await absent(app.getByTestId('dock-file-src/components')); await until(async () => Math.abs((await last.bounds()).y - closedY) < 0.1, 'collapse settles', 10000)
    }
    if (sampler) assert.equal(await sampler.exited, 0)
    console.log('[dock7b-workload-end]', theme)
    const times = run.frameTimes().filter(time => time > traceStart)
    const pacing = summarize(times)
    const result = { ...pacing, contaminated: pacing.max >= 500, capture: 'No screenshots and no clock manipulation in this process', theme, reducedMotion: false, fullRate: true, vsyncWake: process.env.KYBERN_VSYNC_WAKE === '1' }
    writeFileSync(`${out}/pacing-${theme}-normal${suffix}.json`, JSON.stringify(result, null, 2))
    console.log('Live Explorer frame intervals', JSON.stringify({ ...result, intervals: undefined }))
    if (!profile && theme === 'dark') {
      let idleFrames = run.frameTimes().length, lastChange = Date.now()
      await until(async () => {
        const count = run.frameTimes().length
        if (count !== idleFrames) { idleFrames = count; lastChange = Date.now() }
        return Date.now() - lastChange >= 500
      }, 'native motion quiesces before idle sampling', 10000)
      const idleStart = run.frameTimes().length
      const sample = Bun.spawn(['bun', 'perf/sample.ts', '15', `GPUIX=${run.pid}`], { stdout: 'pipe', stderr: 'pipe' })
      const text = await new Response(sample.stdout).text(); assert.equal(await sample.exited, 0)
      writeFileSync(`${out}/idle-explorer${suffix}.txt`, text); writeFileSync(`${out}/idle-frames${suffix}.json`, JSON.stringify({ submittedDuringSample: run.frameTimes().length - idleStart }, null, 2)); console.log(text)
    }
  } finally { await run.close() }
}
