/** ADE-96: real horizontal PR tab workloads with isolated RPC and native rendering. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { actionFixture } from './verify.fixture.ts'
import { launchFixture, waitForPainted } from '../requests/harness.ts'
const baseline = process.argv.includes('--baseline')
const fixture = actionFixture({ horizontal: true, long: true })
let log = ''
const f = await launchFixture(path.join(import.meta.dir, '../main.tsx'), {
  ...fixture.env, KYBERN_APPEARANCE: process.env.KYBERN_APPEARANCE ?? 'dark', KYBERN_WINDOW_SIZE: '1440x900',
  KYBERN_FRAME_COSTS: '1', KYBERN_FRAME_TIMES: '1', KYBERN_OPAQUE: '1', KYBERN_PR_TAB_ISLANDS: baseline ? '0':'1',
}, { stderr: chunk => { log = (log + chunk).slice(-4_000_000) } })
const a = f.app
const pct = (v: number[], q: number) => [...v].sort((a,b) => a-b)[Math.min(v.length-1, Math.floor(v.length*q))] ?? null
const cpu = () => execFileSync('ps', ['-p', String(f.pid), '-o', 'time='], { encoding: 'utf8' }).trim().split(':').map(Number).reduce((n,x)=>n*60+x,0)
const results: object[] = []
async function sample(name: string, run: () => Promise<void>) {
  const start = log.length, frames = f.frameTimes().length, c = cpu(), time = performance.now()
  await run(); await Bun.sleep(300)
  const elapsed = performance.now() - time, seconds = cpu() - c
  const rows = [...log.slice(start).matchAll(/\[kybern-work\] renderMs=([\d.]+) layoutMs=([\d.]+) layoutCalls=(\d+)/g)]
  const times = f.frameTimes().slice(frames), intervals = times.slice(1).map((t,i) => t-times[i]!).filter(t => name.includes('scroll') || t < 250)
  if(process.env.KYBERN_VERIFY_TRACE)console.log('measured',name,Math.round(elapsed),'ms')
  results.push({ name, elapsedMs: elapsed, cpuSeconds: seconds, cpuPercent: seconds * 100_000 / elapsed, frames: times.length,
    frameIntervalP50: pct(intervals,.5), frameIntervalP95: pct(intervals,.95),
    renderP50: pct(rows.map(r=>+r[1]!),.5), renderP95: pct(rows.map(r=>+r[1]!),.95),
    layoutP50: pct(rows.map(r=>+r[2]!),.5), layoutP95: pct(rows.map(r=>+r[2]!),.95),
    nativeInputSamples: [...log.slice(start).matchAll(/\[scroll-input-paint\] packets=(\d+) firstMs=([\d.]+) lastMs=([\d.]+)/g)].length,
    frameTimestampsMs: times, layoutCallsP50: pct(rows.map(r=>+r[3]!),.5), layoutCallsP95: pct(rows.map(r=>+r[3]!),.95),
  })
}
const click = async (id: string) => { await a.getByTestId(id).click(); await Bun.sleep(180) }
async function scroll(id: string) {
  const b = await a.getByTestId(id).bounds()
  for (let i=0;i<100;i++) { await a.mouse.wheel({x:b.x+b.width*.45,y:b.y+Math.min(300,b.height*.6)},0,i<50 ? -40:40); await Bun.sleep(8) }
}
try {
  await a.getByTestId('app-ready').waitFor({timeoutMs:60000})
  await a.getByTestId('pr-summary').waitFor({timeoutMs:15000})
  await waitForPainted(a, 'Verification 1')
  await Bun.sleep(1200)
  await sample('summary-scroll', () => scroll('pr-summary'))
  await click('pr-tab-changes'); await a.getByTestId('pr-native-diff').waitFor(); await Bun.sleep(600)
  await sample('diff-scroll', () => scroll('pr-native-diff'))
  const latencies: number[] = []
  await sample('file-interaction', async () => {
    for(let i=0;i<8;i++) { const start=performance.now(); await a.getByTestId(`pr-file-${i%3}`).click(); await waitForPainted(a, `Transcript${i%3}.tsx`); await a.getByTestId('pr-native-diff').waitFor(); latencies.push(performance.now()-start); await Bun.sleep(180) }
  })
  await click('pr-tab-timeline'); await a.getByTestId('pr-timeline').waitFor(); await Bun.sleep(600)
  await sample('timeline-scroll', () => scroll('pr-timeline'))
  await sample('tab-switch', async () => {
    for(let i=0;i<10;i++) { await click('tab-chat'); await click('tab-pr:pages-fixture:108'); await a.getByTestId('pr-timeline').waitFor() }
  })
  if (!baseline) assert.equal(await a.getByTestId('pr-timeline').count(),1,'Timeline survives switching tabs')
  await click('pr-tab-summary')
  await click('tab-chat'); await click('tab-pr:pages-fixture:108')
  fixture.startStream()
  let deltas=0
  const streaming=setInterval(()=>{ if(deltas<100)fixture.stream(`Hidden stream ${++deltas}. `) },50)
  try {await sample('summary-scroll-hidden-stream',async()=>{for(let i=0;i<3;i++)await scroll('pr-summary')})}finally{clearInterval(streaming)}
  await click('tab-chat'); await waitForPainted(a,`Hidden stream ${deltas}.`)
  await click('tab-pr:pages-fixture:108')
  assert.doesNotMatch(log,/\[error-boundary\]/,'the full workload rendered without fallback errors')
  const report = { hardware:execFileSync('sysctl',['-n','machdep.cpu.brand_string'],{encoding:'utf8'}).trim(), osVersion:execFileSync('sw_vers',['-productVersion'],{encoding:'utf8'}).trim(), addon:process.env.NAPI_RS_NATIVE_LIBRARY_PATH, addonSha256:process.env.NAPI_RS_NATIVE_LIBRARY_PATH ? createHash('sha256').update(readFileSync(process.env.NAPI_RS_NATIVE_LIBRARY_PATH)).digest('hex'):null, platform: process.platform, arch:process.arch, runtime:Bun.version, baseline, control:baseline?'outer PR boundary disabled':'outer PR boundary enabled', results, hiddenStreamDeltas:deltas,
    inputFileP50Ms:pct(latencies,.5), inputFileP95Ms:pct(latencies,.95), inputIncludes:'click to painted selected filename and mounted native diff, including automation round trips; settling delay excluded',
    commitTime:'not exposed separately; native render/layout reported above', energy:'unavailable; no energy instrument collected',
  }
  await a.mouse.move({x:70,y:70}); await Bun.sleep(700)
  if(process.env.KYBERN_VERIFY_OUTPUT) { mkdirSync(process.env.KYBERN_VERIFY_OUTPUT,{recursive:true}); writeFileSync(path.join(process.env.KYBERN_VERIFY_OUTPUT,baseline?'tabs-before.json':'tabs-after.json'),JSON.stringify(report,null,2)); await a.screenshot({path:path.join(process.env.KYBERN_VERIFY_OUTPUT,baseline?'tabs-before.png':'tabs-after.png')}) }
  console.log(JSON.stringify({...report,results:results.map(value=>{const {frameTimestampsMs,...summary}=value as Record<string,unknown>;return summary})},null,2))
} catch(e) { console.error(log.slice(-16000));console.error((await a.call('getAllText',{})).text.join('\n')); if(process.env.KYBERN_VERIFY_OUTPUT){mkdirSync(process.env.KYBERN_VERIFY_OUTPUT,{recursive:true});await a.screenshot({path:path.join(process.env.KYBERN_VERIFY_OUTPUT,'tabs-failure.png')})}; throw e }
finally { await f.close(); fixture.close() }
process.exit(0)
