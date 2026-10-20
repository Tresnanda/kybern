// Frame intervals of the unequal-width pill tween (`SlidingPill`'s layout case) on the Pull requests detail, where the whole page is
// re-laid out per frame, against the equal-width paint case on the Usage group switch... a real-clock measurement, no screenshots.
//   VISUAL_SCRATCH=…/motion-gpuix-p4 VISUAL_DAEMON_PORT=4373 bun native/ui-lease.ts gpuix-p4 bun scripts/motion-p4-pill-cost.ts <label>
import '../src/native/local-build.ts'
import path from 'node:path'
import { launchFixture } from '../src/requests/harness.ts'
import { connect, readState } from '../visual/fixture.ts'
import { ids as startSettingsProxy } from '../visual/fixture.settings.ts'

const SCRATCH = '/Users/mymac/projects/ade-gpuix-scratch/motion-gpuix-p4'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : 0 }
const state = readState()!
const client = await connect(state)
await startSettingsProxy(client)
await fetch(`http://127.0.0.1:${readState()!.port}/mode?value=s9-rich`)
const f = await launchFixture(path.join(import.meta.dir, '..', 'src/main.tsx'), {
  GPUIX_BACKGROUND: '1', KYBERN_OPAQUE: '1', KYBERN_APPEARANCE: 'dark', KYBERN_FRAME_TIMES: '1', KYBERN_WINDOW_SIZE: '1280x820',
  KYBERN_DATA_DIR: `${SCRATCH}/data`, KYBERN_CLIENT_CONFIG_DIR: `${SCRATCH}/client`, KYBERN_GPUIX_CREDENTIALS_DIR: `${SCRATCH}/credentials`, KYBERN_URL: process.env.KYBERN_URL!, KYBERN_TOKEN: process.env.KYBERN_TOKEN!,
})
const a = f.app
const click = async (id: string) => { const c = await a.getByTestId(id).center(); await a.mouse.click(c) }
const out: Record<string, unknown> = { label: process.argv[2] }
async function toggle(name: string, ids: string[]) {
  const times: number[][] = []
  for (let i = 0; i < 12; i++) {
    const mark = f.frameTimes().length
    await click(ids[i % ids.length]!)
    await sleep(600)
    const t = f.frameTimes().slice(mark), iv: number[] = []
    for (let j = 1; j < t.length; j++) iv.push(t[j]! - t[j - 1]!)
    times.push(iv)
  }
  const all = times.flat()
  out[name] = { transitions: 12, intervals: all.length, p50: +pct(all, 0.5).toFixed(1), p95: +pct(all, 0.95).toFixed(1), p99: +pct(all, 0.99).toFixed(1), over16: all.filter(x => x > 16.7).length, over33: all.filter(x => x > 33.4).length, max: +Math.max(...all).toFixed(1) }
}
try {
  await a.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 }); await sleep(3000)
  await click('rail-pulls'); await sleep(1500)
  await click('pr-row-108'); await sleep(2000)
  await toggle('pr-tabs (unequal widths, layout tween)', ['pr-tab-changes', 'pr-tab-summary'])
  await toggle('pr-tabs summary<->timeline', ['pr-tab-timeline', 'pr-tab-summary'])
  await toggle('pr-filter (unequal widths)', ['pr-filter-merged', 'pr-filter-open'])
  await click('rail-usage'); await sleep(2500)
  await toggle('usage-group (unequal widths)', ['usage-group-model', 'usage-group-provider'])
  await click('rail-settings'); await sleep(1500)
  await toggle('settings-tabs (paint pill)', ['settings-tab-appearance', 'settings-tab-general'])
  console.log(JSON.stringify(out, null, 1))
} finally { await f.close(); client.close?.() }
process.exit(0)
