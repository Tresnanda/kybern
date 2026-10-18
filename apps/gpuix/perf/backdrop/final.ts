import {existsSync} from 'node:fs'
import {onExit} from '../bench/lifetime.ts'
if(existsSync('native/build/backdrop-final-pending'))throw Error('Native and visual validation must pass before timing')
for(const args of [['perf/backdrop/measure.ts','acceptance'],['perf/backdrop/measure.ts','diagnosis'],['perf/backdrop/surface.ts']]){
 const child=Bun.spawn(['bun',...args],{stdout:'inherit',stderr:'inherit'})
 const unregister=onExit(async()=>{child.kill();await child.exited});const code=await child.exited;unregister();if(code)throw Error(`${args[0]} failed`)
}
