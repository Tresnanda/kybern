/** Real app, deterministic paged PR workload; native submission timestamps.
 * bun perf/scroll8.ts <label> [dark|light] [0|1 reduced]
 * Scene submits are not physical presentation fences. Input probes include RPC.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { connectStdio } from '@gpuix/react/automation'
import { readOnlyPrFixture } from './scroll8-real-fixture.ts'
import { actionFixture } from '../src/pulls/verify.fixture.ts'
import { pacingLock,waitForNativeBuilds } from './scroll8-lock.ts'

const label = process.argv[2] ?? 'baseline', theme = process.argv[3] ?? 'dark', reduce = process.argv[4] ?? '0'
const out = '/Users/mymac/projects/ade/previews/gpuix/round8/scroll'
const ungated=process.env.SCROLL8_UNGATED==='1'
const config={layout:process.env.KYBERN_SCROLL_LAYOUT??'1',islands:process.env.KYBERN_SCROLL_ISLANDS??'1',coalesce:process.env.KYBERN_SCROLL_COALESCE??(process.env.KYBERN_SCROLL_LAYOUT==='0'?'0':'pr'),frameDraw:process.env.KYBERN_INPUT_FRAME_DRAW??'0',profile:process.env.SCROLL8_PROFILE==='1',phases:process.env.SCROLL8_PHASES!=='0'}
mkdirSync(out, { recursive: true })
await waitForNativeBuilds()
const release = await pacingLock(), fixture = process.env.SCROLL8_REAL === '1' ? await readOnlyPrFixture() : actionFixture({ long: true })
const child = spawn('bun', [ungated?path.resolve(import.meta.dir,'../native/scroll8-lab.tsx'):path.join(import.meta.dir, 'pacing-app.ts')], { env: { ...process.env, ...fixture.env, SCROLL8_LAB_UNGATED:ungated?'1':'0',KYBERN_APPEARANCE: theme, KYBERN_REDUCED_MOTION: reduce, KYBERN_FRAME_TIMES: '1', KYBERN_DEBUG_ISLANDS: '1', KYBERN_FRAME_COSTS: '1', KYBERN_FULL_RATE: '1', KYBERN_INPUT_FRAME_DRAW:process.env.KYBERN_INPUT_FRAME_DRAW??'0', KYBERN_SCROLL_COALESCE: process.env.KYBERN_SCROLL_COALESCE ?? (process.env.KYBERN_SCROLL_LAYOUT==='0'?'0':'pr') }, stdio: ['pipe', 'pipe', 'pipe'] })
let raw = '', pending = '', commits = 0, renders = 0
let latestCache={hits:0,nodes:0}
const costs:{renderMs:number;layoutMs:number;layoutCalls:number;cacheHits:number;reusedNodes:number}[]=[]
const cacheStats:{hits:number;nodes:number}[]=[]
const inputPaints:{packets:number;firstMs:number;lastMs:number;pending:number;received:number}[]=[]
const frames: { native: number; received: number }[] = []
child.stderr.on('data', chunk => {
  const value = String(chunk); raw += value; pending += value
  const end = pending.lastIndexOf('\n'); if (end < 0) return
  for (const line of pending.slice(0, end).split('\n')) {
    const m = line.match(/\[kybern-submit\] ([\d.]+)/)
    if (m) frames.push({ native: Number(m[1]), received: performance.now() })
    const cache=line.match(/\[scroll-layout-frame\] hits=(\d+) nodes=(\d+)/)
    if(cache){latestCache={hits:Number(cache[1]),nodes:Number(cache[2])};cacheStats.push(latestCache)}
    const inputPaint=line.match(/\[scroll-input-paint\] packets=(\d+) firstMs=([\d.]+) lastMs=([\d.]+) pending=(\d+)/)
    if(inputPaint)inputPaints.push({packets:Number(inputPaint[1]),firstMs:Number(inputPaint[2]),lastMs:Number(inputPaint[3]),pending:Number(inputPaint[4]),received:performance.now()})
    if (line.includes('[pacing-commit]')) commits++
    if (line.includes('[islands] render ')) renders++
    const cost=line.match(/\[kybern-work\] renderMs=([\d.]+) layoutMs=([\d.]+) layoutCalls=(\d+)/)
    if(cost)costs.push({renderMs:Number(cost[1]),layoutMs:Number(cost[2]),layoutCalls:Number(cost[3]),cacheHits:latestCache.hits,reusedNodes:latestCache.nodes})
  }
  pending = pending.slice(end + 1)
})
const percentile = (values: number[], fraction: number) => [...values].sort((a,b) => a-b)[Math.min(values.length-1, Math.floor(values.length*fraction))] ?? null
let app: Awaited<ReturnType<typeof connectStdio>> | undefined
try {
  app = await Promise.race([
    connectStdio({ write: v => { child.stdin.write(v) }, feed: listener => { child.stdout.on('data', v => listener(String(v))) }, close: async () => { child.kill() } }),
    new Promise<never>((_,reject) => child.once('exit', code => reject(Error(`Exited ${code}: ${raw.slice(-3000)}`)))),
  ])
  await app.getByTestId(ungated?'ready':'app-ready').waitFor({ timeoutMs: 60000 })
  if(!ungated){await app.getByTestId('rail-pulls').click();await app.getByTestId(`pr-row-${process.env.SCROLL8_PR_NUMBER??108}`).waitFor()}
  const results: unknown[] = []
  let opened=ungated
  for (const scene of (process.env.SCROLL8_SCENES??'list,summary,changes,timeline').split(',')) {
    if(scene!=='list'&&!opened){await app.getByTestId(`pr-row-${process.env.SCROLL8_PR_NUMBER??108}`).click();await app.getByTestId('pr-summary').waitFor();opened=true}
    if (scene === 'changes' || scene === 'timeline') { await app.getByTestId(`pr-tab-${scene}`).click(); if(scene==='changes')await app.getByTestId('pr-native-diff').waitFor();else await app.getByTestId('pr-timeline').waitFor() }
    if(scene==='changes'&&process.env.SCROLL8_FILE_INDEX){
      const name=`pr-file-${process.env.SCROLL8_FILE_INDEX}`,area=await app.getByTestId('pr-changes').bounds()
      let visible=false
      for(let n=0;n<12;n++){
        try{const b=await app.getByTestId(name).bounds();if(b.y>=area.y&&b.y+b.height<=area.y+area.height){visible=true;break}}catch{}
        const painted=inputPaints.length
        await app.mouse.wheel({x:area.x+100,y:area.y+area.height/2},0,-100)
        const end=Date.now()+2000
        while(inputPaints.length===painted&&Date.now()<end)await Bun.sleep(5)
      }
      if(!visible)throw Error(`Real file ${name} is not reachable`)
      await app.getByTestId(name).click()
    }
    // Native virtual-list itself has no automation hitbox; use the surrounding
    // PR page, whose geometry is recorded, or the native diff viewport.
    const target = app.getByTestId(ungated?'ready':scene === 'changes' ? 'pr-native-diff' : 'page-pulls')
    const deadline = Date.now() + 10000
    let b: { x: number; y: number; width: number; height: number } | undefined
    while (!b) {
      try { b = await target.bounds() } catch (e) { if (Date.now() > deadline) throw e; await Bun.sleep(20) }
    }
    // Resolve bounds once: tree inspection must not throttle each wheel packet.
    const point = { x: ungated?b.x+b.width/2:scene === 'list' ? b.x+176 : scene === 'changes' ? b.x+b.width/2 : b.x+352+(b.width-352)/2, y: b.y+b.height/2 }
    await app.mouse.move(point)
    // Warm up the scene before timing. No screenshots during this run.
    const drive=async(count:number,warm:boolean)=>{
      const start=performance.now(),acks:number[]=[],sentTimes:number[]=[],pending:Promise<unknown>[]=[]
      let outstanding=0,maxOutstanding=0
      for(let i=0;i<count;i++){
        const phase=i%300,cycle=i%600
        const delta=warm?(phase<120?3:3*Math.exp(-(phase-120)/45)):(phase<120?6*Math.sin(Math.PI*Math.min(phase+1,30)/60):6*Math.exp(-(phase-120)/45))
        const touchPhase=phase===0||phase===120?'started':phase===119||phase===299?'ended':'moved'
        const sent=performance.now();sentTimes.push(sent);outstanding++;maxOutstanding=Math.max(maxOutstanding,outstanding)
        // Do not serialize packet production behind frame work. Native input
        // also continues arriving when one frame takes longer than 8.3 ms.
        pending.push((process.env.SCROLL8_INPUT==='pointer'?app!.mouse.move({x:point.x+Math.sin(i/8)*45,y:point.y+Math.sin(i/22)*130}):process.env.SCROLL8_PHASES==='0'?app!.mouse.wheel(point,0,(cycle<300?-1:1)*delta):app!.call('scrollWheel',{...point,deltaX:0,deltaY:(cycle<300?-1:1)*delta,phase:touchPhase})).then(()=>{acks.push(performance.now()-sent);outstanding--}))
        const deadline=start+(i+1)*1000/120
        if(deadline>performance.now())await Bun.sleep(deadline-performance.now())
      }
      const productionEnded=performance.now(),offeredMs=productionEnded-start
      await Promise.all(pending)
      return{acks,sentTimes,maxOutstanding,offeredMs,productionEnded,drainMs:performance.now()-start-offeredMs}
    }
    await drive(Number(process.env.SCROLL8_WARM_PACKETS??1200),true)
    // A non-wheel ordering barrier flushes a final warm-up batch before the
    // timed packet accounting. Geometry is queried only outside the hot loop.
    await app.mouse.move(point);await target.bounds()
    const profiler=process.env.SCROLL8_PROFILE==='1'?Bun.spawn(['sample',String(child.pid),'5','-file',`${out}/profile-${scene}.txt`],{stdout:'ignore',stderr:'ignore'}):undefined
    const sampler = Bun.spawn(['bun',path.join(import.meta.dir,'sample.ts'),'15',`GPUIX=${child.pid}`],{stdout:'pipe',stderr:'pipe'})
    const first=frames.length,c0=commits,r0=renders,work0=costs.length,cache0=cacheStats.length,input0=inputPaints.length
    const start=performance.now(),input=await drive(Number(process.env.SCROLL8_PACKETS??1800),false),packets=input.acks
    const inputMs=performance.now()-start
    const latency=input.sentTimes.flatMap(sent=>{const next=frames.slice(first).find(f=>f.received>=sent);return next?[next.received-sent]:[]})
    const resourceText = await new Response(sampler.stdout).text(); await sampler.exited;await profiler?.exited
    const times = frames.slice(first), intervals = times.slice(1).map((v,i) => v.native-times[i]!.native)
    const work=costs.slice(work0)
    const applied=inputPaints.slice(input0)
    // Match CPU-paint telemetry to offered packets in FIFO order only when
    // every timed packet is accounted for. A batch overlapping warm-up or a
    // no-paint/clamped input makes this invalid; report no estimate then.
    const paintedPacketCount=applied.reduce((n,v)=>n+v.packets,0)
    const matchedCpuPaint:number[]=[]
    if(paintedPacketCount===input.sentTimes.length){
      let cursor=0
      for(const paint of applied)for(let n=0;n<paint.packets;n++)matchedCpuPaint.push(paint.received-input.sentTimes[cursor++]!)
    }
    results.push({ scene, offeredPacketToCpuPaintReceiptP50:percentile(matchedCpuPaint,.5),offeredPacketToCpuPaintReceiptP95:percentile(matchedCpuPaint,.95),matchedCpuPaintPackets:matchedCpuPaint.length,unmatchedCpuPaintPackets:paintedPacketCount-input.sentTimes.length,nativeBatchPacketsP50:percentile(applied.map(v=>v.packets),.5),nativeBatchPacketsMax:Math.max(0,...applied.map(v=>v.packets)),nativeFirstPacketToCpuPaintP50:percentile(applied.map(v=>v.firstMs),.5),nativeFirstPacketToCpuPaintP95:percentile(applied.map(v=>v.firstMs),.95),nativeLastPacketToCpuPaintP95:percentile(applied.map(v=>v.lastMs),.95),nativePendingSlotMax:Math.max(0,...applied.map(v=>v.pending)),nativePaintDrainMs:Math.max(0,(applied.at(-1)?.received??input.productionEnded)-input.productionEnded),nativeAppliedPackets:applied.reduce((n,v)=>n+v.packets,0), offeredMs:input.offeredMs, drainMs:input.drainMs, maxOutstanding:input.maxOutstanding, solverCallsP50:percentile(work.map(v=>v.layoutCalls-v.cacheHits),.5),cacheHitsP50:percentile(work.map(v=>v.cacheHits),.5), reusedNodesP50:percentile(work.map(v=>v.reusedNodes),.5), inputMs, deliveredHz:packets.length/(inputMs/1000), resourceText, input: process.env.SCROLL8_INPUT==='pointer'?'120 Hz native pointer RPC, sinusoidal trajectory':`120 Hz precise pixel RPC, contact/ramp + exponential synthetic momentum; ${config.phases?'native Started/Moved/Ended phase markers':'phase-less control'}, no separate GPUI momentum flag`, packetAckP50:percentile(packets,.5),packetAckP95:percentile(packets,.95),workFrameCount:work.length,frameCount: times.length, p50: percentile(intervals,.5), p95: percentile(intervals,.95), offeredPacketToNextSubmissionReceiptP50: percentile(latency,.5), offeredPacketToNextSubmissionReceiptP95: percentile(latency,.95), latencySamples: latency.length, commits: commits-c0, islandRenders: renders-r0, renderMsP50:percentile(work.map(v=>v.renderMs),.5),renderMsP95:percentile(work.map(v=>v.renderMs),.95),layoutMsP50:percentile(work.map(v=>v.layoutMs),.5),layoutMsP95:percentile(work.map(v=>v.layoutMs),.95),layoutCallsP50:percentile(work.map(v=>v.layoutCalls),.5), elapsedMs: performance.now()-start, packets, intervals })
    if (input.drainMs > 30000) {
      writeFileSync(`${out}/${label}-${theme}-${reduce}.json`, JSON.stringify({ pid: child.pid, label, theme, reduce, config, results, stalled: true }, null, 2))
      break
    }
    if (process.env.KYBERN_PACING_SCREENSHOTS === '1') await app.screenshot({ path: `${out}/${label}-${theme}-${reduce}-${scene}.png` })
    writeFileSync(`${out}/${label}-${theme}-${reduce}.json`, JSON.stringify({ pid: child.pid, label, theme, reduce, config, results }, null, 2))
    console.log(JSON.stringify({...results.at(-1) as object, intervals: undefined,packets:undefined}))
  }
  writeFileSync(`${out}/${label}-${theme}-${reduce}.json`, JSON.stringify({ pid: child.pid, label, theme, reduce, config, results }, null, 2))
} finally {
  writeFileSync(`${out}/${label}-${theme}-${reduce}.log`, raw)
  try { await app?.close() } catch {}
  child.kill(); fixture.close(); release()
}
