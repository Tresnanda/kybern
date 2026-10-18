import {execFileSync} from 'node:child_process'
import {mkdirSync,existsSync,readdirSync} from 'node:fs'
const count=Number(process.argv[2]??1000),stream=process.argv[3]==='stream'
const data='/Users/mymac/projects/ade-gpuix-scratch/perf-transcript';mkdirSync(data,{recursive:true})
const bench=existsSync(import.meta.dir+'/../bench/wheel.m')?import.meta.dir+'/../bench/wheel.m':'/Users/mymac/projects/ade-gpuix-perf-bench/apps/gpuix/perf/bench/wheel.m'
if(!existsSync(data+'/transcript-wheel.dylib')){
 if(readdirSync('/tmp').some(name=>name.startsWith('kybern-gpuix-quiet.')))throw Error('Prepare the tiny AppKit injector before reserving a quiet window')
 execFileSync('clang',['-dynamiclib','-fobjc-arc','-framework','Cocoa','-framework','CoreGraphics',bench,'-o',data+'/transcript-wheel.dylib'])
}
for(const [label,slots,layout,coalesce] of [['baseline-appkit','0','0','0'],['appkit-window','0','1','0'],['appkit-slots','1','1','0'],['appkit-coalesced','1','1','pr']]){
 const child=Bun.spawn(['bun',import.meta.dir+'/run.ts',`${label}${stream?'-stream':''}`,String(count)],{env:{...process.env,TRANSCRIPT_INPUT:'appkit',TRANSCRIPT_PAIR:'1',KYBERN_TRANSCRIPT_WINDOW_BUFFER:'0',KYBERN_TRANSCRIPT_SLOT_CACHE:slots!,TRANSCRIPT_SCENES:stream?'scroll':label==='baseline-appkit'?'scroll,fling':'scroll,fling,idle',TRANSCRIPT_STREAM:stream?'1':'0',KYBERN_TRANSCRIPT_LAYOUT:layout!,KYBERN_SCROLL_COALESCE:coalesce!},stdout:'inherit',stderr:'inherit'})
 if(await child.exited)throw Error('Slot cache comparison failed')
}
export {}
