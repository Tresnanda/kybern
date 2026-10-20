import {requireScreen} from '../bench/screen-state.ts'
import {writeFileSync} from 'node:fs'
const before=requireScreen()
const child=Bun.spawn(['bun','src/tasks/round7b-check.ts'],{env:process.env,stdout:'inherit',stderr:'inherit'})
for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>child.kill(signal))
try{process.exitCode=await child.exited}finally{child.kill();const after=requireScreen();writeFileSync(`${process.env.R8_OUT}/${process.env.R7_LABEL}-screen.json`,JSON.stringify({before,after},null,2))}
