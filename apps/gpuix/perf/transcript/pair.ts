import assert from 'node:assert/strict'
import {pixels} from '../../native/png.ts'
// One matched P2 A/B plus separate (untimed) captures, inside one <5min lease.
for(const label of ['baseline-repeat','mounts']) {
 const child=Bun.spawn(['bun',import.meta.dir+'/run.ts',label,'1000'],{env:{...process.env,TRANSCRIPT_PAIR:'1'},stdout:'inherit',stderr:'inherit'})
 if(await child.exited)throw Error(`${label} failed`)
}
for(const theme of ['dark','light'])for(const label of ['baseline-visual','mounts-visual']){
 const child=Bun.spawn(['bun',import.meta.dir+'/run.ts',label,'1000',theme],{env:{...process.env,TRANSCRIPT_PAIR:'1',TRANSCRIPT_CAPTURE:'1'},stdout:'inherit',stderr:'inherit'})
 if(await child.exited)throw Error(`${label} ${theme} failed`)
}
for(const theme of ['dark','light']){
 const root='/Users/mymac/projects/ade/previews/gpuix/perf/transcript'
 const a=pixels(`${root}/baseline-visual-1000-${theme}.png`),b=pixels(`${root}/mounts-visual-1000-${theme}.png`)
 assert.equal(a.w,b.w);assert.equal(a.h,b.h)
 let changed=0
 for(let y=4;y<a.h-4;y++)for(let x=4;x<a.w-4;x++){if(y>a.h-52&&(x<52||x>a.w-52))continue;const p=a.at(x,y),q=b.at(x,y);if(p.some((v,j)=>v!==q[j]))changed++}
 console.log(JSON.stringify({theme,changedPixels:changed}))
 assert.equal(changed,0,`Transcript initial tail pixels differ in ${theme}`)
}
const verify=Bun.spawn(['bun',import.meta.dir+'/verify.ts'],{env:{...process.env,TRANSCRIPT_PAIR:'1'},stdout:'inherit',stderr:'inherit'})
if(await verify.exited)throw Error('Transcript navigation/selection verification failed')
export {}
