import {onExit} from '../bench/lifetime.ts'
for(const phase of ['diagnosis','acceptance']){
 const child=Bun.spawn(['bun','perf/gpu/measure.ts',phase],{env:process.env,stdin:'inherit',stdout:'inherit',stderr:'inherit'})
 const cleanup=onExit(async()=>{child.kill();await child.exited})
 const code=await child.exited;cleanup();if(code)throw Error(`${phase} failed (${code})`)
}
