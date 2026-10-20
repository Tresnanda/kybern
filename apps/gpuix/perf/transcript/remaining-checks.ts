import {writeFileSync} from 'node:fs'
const out='/Users/mymac/projects/ade/previews/gpuix/perf/transcript'
if(process.env.TRANSCRIPT_SKIP_STATIC!=='1')for(const [name,command] of [['typecheck',['pnpm','exec','tsc','--noEmit']],['harness-typecheck',['pnpm','exec','tsc','-p','perf/transcript/tsconfig.json']],['tests',['bun','test','./src']]] as const){
 const child=Bun.spawn([...command],{env:process.env,stdout:'pipe',stderr:'pipe'})
 const [stdout,stderr]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text()]);writeFileSync(`${out}/${name}.log`,stdout+stderr)
 if(await child.exited)throw Error(name+' failed: '+(stdout+stderr).slice(-2000));console.log(`PASS ${name}`)
}
for(const compact of ['0','1']){
 const child=Bun.spawn(['bun','perf/transcript/verify.ts'],{env:{...process.env,TRANSCRIPT_COMPACT:compact,KYBERN_TRANSCRIPT_WINDOW_BUFFER:'1',KYBERN_TRANSCRIPT_SLOT_CACHE:'1',KYBERN_TRANSCRIPT_LAYOUT:'1'},stdout:'pipe',stderr:'pipe'})
 const [stdout,stderr]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text()]);writeFileSync(`${out}/final-verify-${compact}.log`,stdout+stderr)
 if(await child.exited)throw Error('Transcript verification failed: '+(stdout+stderr).slice(-2000));console.log(`PASS transcript compact=${compact}`)
}
const counts=Bun.spawn(['bun','perf/transcript/counts.ts'],{env:process.env,stdout:'inherit',stderr:'inherit'});if(await counts.exited)throw Error('Counts failed')

const pixels=Bun.spawn(['bun','perf/transcript/p1-visual.ts'],{env:process.env,stdout:'pipe',stderr:'pipe'})
const [pixelOut,pixelErr]=await Promise.all([new Response(pixels.stdout).text(),new Response(pixels.stderr).text()]);writeFileSync(`${out}/final-pixels.log`,pixelOut+pixelErr)
if(await pixels.exited)throw Error('Final pixel comparison failed: '+(pixelOut+pixelErr).slice(-2000))
writeFileSync(`${out}/final-correctness-ready.json`,JSON.stringify({passed:true,at:new Date().toISOString()}))
console.log('PASS final pixels; ready for final timing')
