/** Single-scenario JSON entry point; delegates all lifecycle/leases to run.ts. */
import {onExit} from './lifetime.ts'
import {readFileSync} from 'node:fs'
import path from 'node:path'
import {SCENARIOS,type Scenario} from './model.ts'
const [name,...args]=process.argv.slice(2)
if(!SCENARIOS.includes(name as Scenario))throw Error(`Choose a scenario: ${SCENARIOS.join(', ')}`)
const label=`scenario-${name}-${process.pid}`
const child=Bun.spawn(['bun',path.join(import.meta.dir,'run.ts'),name!,'--label',label,'--runs','1',...args],{stdout:'ignore',stderr:'inherit'})
const unchild=onExit(async()=>{child.kill();await child.exited})
const code=await child.exited;unchild()
const doc=JSON.parse(readFileSync(path.join(import.meta.dir,`results/${label}.json`),'utf8'))
console.log(JSON.stringify(doc,null,2));process.exitCode=code
