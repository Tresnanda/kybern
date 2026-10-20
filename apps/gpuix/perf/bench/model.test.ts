import {test,expect} from 'bun:test'
import {distribution,emptyResult,table} from './model.ts'
import {Telemetry,parseResources} from './telemetry.ts'
test('frame quantiles and empty samples retain missingness',()=>{expect(distribution([])).toEqual({p50:null,p95:null,p99:null,max:null});expect(distribution([1,100,2,3]).p95).toBe(100)})
test('native stream parser handles split lines and uses submission timestamps',()=>{
 const t=new Telemetry();t.stderr('[kybern-sub');t.stderr('mit] 0\n[kybern-work] renderMs=4.2 layoutMs=2.1 layoutCalls=7\n[pacing-commit] 2\n[kybern-submit] 16.6\n[kybern-submit] 55\n');const r=t.result({frames:0,costs:0,commits:0});expect(r.frames.count).toBe(3);expect(r.frames.over16_7).toBe(1);expect(r.frames.over33).toBe(1);expect(r.frames.max).toBeCloseTo(38.4);expect(r.work.layoutMs.p50).toBe(2.1);expect(r.work.reactCommits).toBe(1)
})
test('continuous scroll counts a stall before its first measured submission',()=>{
 const t=new Telemetry();t.stderr('[kybern-submit] 100\n')
 const mark=t.mark();t.stderr('[kybern-submit] 5100\n[kybern-submit] 5116.7\n')
 expect(t.result(mark,[],true).frames).toMatchObject({count:2,over33:1,max:5000})
 expect(t.result(mark).frames.over33).toBe(0)
})
test('resource parser reads only the total and preserves actual sample interval',()=>{expect(parseResources('  total                                      241.0 MiB  cpu  12.34%  gpu   456.7 ms over 15.08s')).toEqual({footprintMiB:241,cpuPercent:12.34,gpuMs:456.7,sampleSeconds:15.08});expect(()=>parseResources('failed')).toThrow()})
test('missing runs never render as zero performance',()=>{const r=emptyResult('thread-scroll',1);r.status='failed';r.reason='No scene';expect(table([r])).toContain('0/1');expect(table([r])).toContain('— / — / —')})

import {mkdtempSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {nativeBuildMarkers,buildOverlap,watchBuilds} from './build-overlap.ts'
test('build-overlap gate recognizes either endpoint without touching other lane markers',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'gpuix-bench-marker-test-'))
 try{writeFileSync(path.join(dir,'kybern-gpuix-native-build.test'),'');writeFileSync(path.join(dir,'unrelated'),'');expect(nativeBuildMarkers(dir)).toEqual(['kybern-gpuix-native-build.test']);expect(buildOverlap([],[])).toBe(false);expect(buildOverlap(['lane'],[])).toBe(true);expect(buildOverlap([],['lane'])).toBe(true)}finally{rmSync(dir,{recursive:true,force:true})}
})

test('build watcher catches a marker removed before the final endpoint',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'gpuix-bench-watch-test-')),marker=path.join(dir,'kybern-gpuix-native-build.short')
 writeFileSync(path.join(dir,'kybern-gpuix-quiet.test'),'')
 const watch=watchBuilds(dir)
 try{writeFileSync(marker,'');await Bun.sleep(30);rmSync(marker);await Bun.sleep(30);const gate=watch.finish();expect(gate.buildMarkersAfter).toEqual([]);expect(gate.quietMarkersBefore).toEqual(['kybern-gpuix-quiet.test']);expect(gate.quietMarkersAfter).toEqual(['kybern-gpuix-quiet.test']);expect(gate.overlap).toBe(true);expect(gate.buildMarkersDuring).toContain('kybern-gpuix-native-build.short')}finally{watch.finish();rmSync(dir,{recursive:true,force:true})}
})

import {foreignProcesses} from './process-gate.ts'
test('process gate excludes this runner descendants but rejects cancelled-run orphans',()=>{
 const rows=['20 bun /tmp/ade-gpuix/perf/bench/app.ts','21 bun /tmp/ade-gpuix/perf/sample.ts 15 GPUIX=20','30 bun /tmp/ade-gpuix/native/markdown-fixture.ts','40 /bin/sh -c pgrep -fl "bun .*ade-gpuix"','50 /opt/homebrew/bin/bun /tmp/ade-gpuix/perf/bench/run.ts','60 bun native/ui-lease.ts update-ade-gpuix-perf-markdown sh native/check.sh']
 const parents=new Map([[20,10],[21,10],[30,1],[40,1],[50,1]])
 expect(foreignProcesses(rows,parents,10)).toEqual([rows[2]!])
 parents.set(20,1)
 expect(foreignProcesses(rows,parents,10)).toEqual([rows[0]!,rows[2]!])
 const proxy='70 bun /tmp/ade-gpuix/visual/fixture.conversation.ts --proxy {}'
 const window='71 bun /tmp/ade-gpuix/visual/fixture.conversation.ts'
 expect(foreignProcesses([proxy,window],parents,10)).toEqual([window])
})

import {quietOrder,assertQuietTurn} from './build-overlap.ts'
test('quiet ordering honors the first line and legacy reservation without editing them',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'gpuix-bench-quiet-test-'))
 try{
  writeFileSync(path.join(dir,'kybern-gpuix-quiet-order'),'perf-transcript\nperf-markdown\nperf-bench\n')
  writeFileSync(path.join(dir,'kybern-gpuix-quiet.perf-bench'),'')
  expect(quietOrder(dir)).toEqual(['perf-transcript','perf-markdown','perf-bench'])
  expect(()=>assertQuietTurn('perf-bench',dir)).toThrow('out of turn')
  writeFileSync(path.join(dir,'kybern-gpuix-quiet-next.perf-bench'),'')
  expect(quietOrder(dir)).toEqual(['perf-bench','perf-transcript','perf-markdown'])
  expect(()=>assertQuietTurn('perf-bench',dir)).not.toThrow()
  rmSync(path.join(dir,'kybern-gpuix-quiet.perf-bench'))
  expect(()=>assertQuietTurn('unreserved-normal-run',dir)).not.toThrow()
 }finally{rmSync(dir,{recursive:true,force:true})}
})

test('CPU input-paint probes are sequence-bounded and separate from next-submission proxies',()=>{
 const t=new Telemetry()
 t.stderr('[scroll-input-paint] packets=8 firstMs=200 lastMs=190 pending=0\n')
 const mark=t.mark()
 t.stderr('[scroll-input-paint] packets=2 firstMs=17.5 lastMs=8.2 pending=0\n[scroll-input-paint] packets=1 firstMs=16 lastMs=16 pending=0\n')
 const input=t.result(mark).nativeInput
 expect(input.samples).toBe(2);expect(input.packets).toBe(3)
 expect(input.firstMs.max).toBe(17.5);expect(input.lastMs.p50).toBe(16)
 expect(t.result(mark).proxy.p95).toBeNull()
})

import {parseScreenState,requireActiveSample} from './screen-state.ts'
test('locked/asleep and empty active samples cannot be accepted',()=>{
 expect(parseScreenState('locked: 0 onConsole: 1\ndisplayAsleep: false').valid).toBe(true)
 for(const raw of ['locked: 1\ndisplayAsleep: false','locked: 0\ndisplayAsleep: true','locked: nil\ndisplayAsleep: 0','unavailable'])expect(parseScreenState(raw).valid).toBe(false)
 expect(()=>requireActiveSample(0,0,15)).toThrow()
 expect(()=>requireActiveSample(1,3,15)).toThrow()
 expect(()=>requireActiveSample(900,0,15)).toThrow()
 expect(()=>requireActiveSample(75,120,15)).not.toThrow()
})

test('startup report exposes distinct sidebar, first and newest content median/p90',()=>{
 const rows=Array.from({length:5},(_,i)=>({...emptyResult('startup-cold',i+1),timings:{firstPaintedShellMs:100+i,sidebarPaintMs:200+i,firstContentMs:300+i,newestContentMs:400+i}}))
 const report=table(rows)
 expect(report).toContain('Sidebar median/p90 ms')
 expect(report).toContain('| startup-cold | 102.00 / 104.00 | 202.00 / 204.00 | 302.00 / 304.00 | 402.00 / 404.00 |')
})


import {parseWindowOnscreen} from './window-onscreen.ts'
test('capture guard requires a visible window contained on the hidden 2x display',()=>{
 const window=(x:number,y:number,scale:number,onscreen=true,width=1280)=>`window 42 onscreen=${onscreen} scale=${scale} bounds={X = ${x}; Y = ${y}; Width = ${width}; Height = 820;}`
 expect(parseWindowOnscreen(window(-1360,940,2)).valid).toBe(true)
 expect(parseWindowOnscreen(window(-1360,940,2).replace("X = -1360", 'X = "-1360"')).valid).toBe(true)
 for(const raw of [window(80,40,2),window(-1360,940,1),window(-1360,940,2,false),window(-1500,940,2),window(-1360,899,2),window(-1360,1000,2),window(-1360,940,2,true,1400),''])expect(parseWindowOnscreen(raw).valid).toBe(false)
})


test('fixture proxy helpers do not count as native windows',()=>{
 const rows=['20 bun /work/ade-gpuix-lane/apps/gpuix/visual/fixture.conversation.ts --proxy {}','21 bun /work/ade-gpuix-lane/apps/gpuix/visual/fixture.settings.ts --proxy {}','22 bun /work/ade-gpuix-lane/apps/gpuix/visual/fixture.settings.ts']
 expect(foreignProcesses(rows,new Map(),10)).toEqual([rows[2]!])
})
