import {test,expect} from 'bun:test'
import {distribution,emptyResult,table} from './model.ts'
import {Telemetry,parseResources} from './telemetry.ts'
test('frame quantiles and empty samples retain missingness',()=>{expect(distribution([])).toEqual({p50:null,p95:null,p99:null,max:null});expect(distribution([1,100,2,3]).p95).toBe(100)})
test('native stream parser handles split lines and uses submission timestamps',()=>{
 const t=new Telemetry();t.stderr('[kybern-sub');t.stderr('mit] 0\n[kybern-work] renderMs=4.2 layoutMs=2.1 layoutCalls=7\n[pacing-commit] 2\n[kybern-submit] 16.6\n[kybern-submit] 55\n');const r=t.result({frames:0,costs:0,commits:0});expect(r.frames.count).toBe(3);expect(r.frames.over16_7).toBe(1);expect(r.frames.over33).toBe(1);expect(r.frames.max).toBeCloseTo(38.4);expect(r.work.layoutMs.p50).toBe(2.1);expect(r.work.reactCommits).toBe(1)
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
 const rows=['20 bun /tmp/ade-gpuix/perf/bench/app.ts','21 bun /tmp/ade-gpuix/perf/sample.ts 15 GPUIX=20','30 bun /tmp/ade-gpuix/native/markdown-fixture.ts','40 /bin/sh -c pgrep -fl "bun .*ade-gpuix"','50 /opt/homebrew/bin/bun /tmp/ade-gpuix/perf/bench/run.ts']
 const parents=new Map([[20,10],[21,10],[30,1],[40,1],[50,1]])
 expect(foreignProcesses(rows,parents,10)).toEqual([rows[2]!])
 parents.set(20,1)
 expect(foreignProcesses(rows,parents,10)).toEqual([rows[0]!,rows[2]!])
})
