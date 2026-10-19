import {existsSync} from 'node:fs'
import {onExit} from '../bench/lifetime.ts'
if(existsSync('native/build/backdrop-final-pending'))throw Error('Native and visual validation must pass before timing')
const stages=process.argv[2]==='details'?[['perf/backdrop/measure.ts','diagnosis'],['perf/backdrop/measure.ts','reverse'],['perf/backdrop/surface.ts'],['perf/backdrop/measure.ts','idle'],['perf/backdrop/measure.ts','original-reverse']]:[['perf/backdrop/measure.ts','acceptance']]
for(const args of stages){
 const child=Bun.spawn(['bun',...args],{stdout:'inherit',stderr:'inherit'})
 const unregister=onExit(async()=>{child.kill();await child.exited});const code=await child.exited;unregister();if(code)throw Error(`${args[0]} failed`)
}
