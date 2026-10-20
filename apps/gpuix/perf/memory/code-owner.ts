/** Untimed, opt-in ownership probes. Never compare profiled footprints to normal runs. */
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { launchFixture } from '../../src/requests/harness.ts'
import { lease } from './lease.ts'
import { assertTestDisplayWindow } from '../images/onscreen.ts'
import { metadata } from './metadata.ts'
import { requireScreen } from '../bench/screen-state.ts'
import { drive } from '../bench/input.ts'
const label = process.argv[2] ?? 'owner'
const data = process.env.KYBERN_DATA_DIR!
assert(data.includes('scratch'))
const out = path.join(process.env.KYBERN_MEMORY_EVIDENCE!, label); mkdirSync(out, {recursive:true})
const client = path.join(data, `client-${label}`); mkdirSync(client, {recursive:true})
const stackDir = path.join(data, `stacks-${label}`); mkdirSync(stackDir, {recursive:true})
const addon = path.resolve('native/build/gpuix-native.darwin-arm64.node')
metadata(out, addon, false)
const release = await lease()
const f = await launchFixture(path.join(import.meta.dir, 'lab.tsx'), {
 KYBERN_DATA_DIR:data, KYBERN_CLIENT_CONFIG_DIR:client, KYBERN_URL:'', KYBERN_TOKEN:'', GPUIX_BACKGROUND:'1', KYBERN_FULL_RATE:'1', KYBERN_MEMORY_COUNTERS:'1',
 ...(process.env.KYBERN_MEMORY_STACKS === '1' ? {MallocStackLogging:'1', MallocStackLoggingNoCompact:'1', MallocStackLoggingDirectory:stackDir} : {}),
})
let log='';
const probe = (file:string, command:string, args:string[]) => {
 try {const raw = execFileSync(command,args,{encoding:'utf8',maxBuffer:64*1024*1024,timeout:30000});writeFileSync(path.join(out,file),raw);return raw}
 catch(e){writeFileSync(path.join(out,file),String(e));return ''}
}
try {
 await f.app.getByTestId('app-ready').waitFor()
 await assertTestDisplayWindow(f.pid)
 const port = JSON.parse(readFileSync(path.join(client,'memory-control.json'),'utf8')).port
 const control = async(action:string, args:Record<string,unknown>={}) => (await fetch(`http://127.0.0.1:${port}`,{method:'POST',body:JSON.stringify({action,...args})})).json()
 for(const [name,kind] of [['initial','home'],['open','code'],['closed','home']] as const){
  const scene = kind === 'code' ? process.env.KYBERN_MEMORY_CODE_KIND ?? kind : kind
  await control('scene',{kind:scene,index:0});await Bun.sleep(1000)
  if (scene === 'code-virtual') await f.app.getByTestId('dock-code-chunk-0').waitFor()
  if (scene === 'code-virtual' && process.env.KYBERN_MEMORY_PROBE_SCROLL === '1') {
   const b=await f.app.getByTestId('dock-file-content').bounds()
   await drive(f.app,{x:b.x+b.width/2,y:b.y+b.height/2},25000)
  }
  await f.app.call('blur',{});await Bun.sleep(1000)
  await assertTestDisplayWindow(f.pid)
  requireScreen()
  writeFileSync(path.join(out,`${name}-stats.json`),JSON.stringify(await control('stats'),null,2))
  probe(`${name}-vmmap.txt`,'vmmap',['-summary',String(f.pid)])
  probe(`${name}-footprint.txt`,'footprint',['-p',String(f.pid)])
  probe(`${name}-heap.txt`,'heap',['-s','-H',String(f.pid)])
  if(process.env.KYBERN_MEMORY_SNAPSHOTS==='1'){
   const {file}=await control('snapshot',{kind:name}) as {file:string};copyFileSync(file,path.join(out,`${name}.heapsnapshot`))
   writeFileSync(path.join(out,`${name}-post-snapshot-stats.json`),JSON.stringify(await control('stats'),null,2))
  }
 }
 const rounds = Number(process.env.KYBERN_MEMORY_PROBE_ROUNDS ?? '0')
 assert(Number.isInteger(rounds) && rounds >= 0 && rounds <= 12)
 const cycles: unknown[] = []
 for (let round = 0; round < rounds; round++) {
  const kind=process.env.KYBERN_MEMORY_CODE_KIND ?? 'code'
  await control('scene',{kind,index:0})
  await f.app.getByTestId(kind==='code-virtual'?'dock-code-chunk-0':'memory-code').waitFor()
  await Bun.sleep(200)
  await control('scene',{kind:'home',index:0});await Bun.sleep(1000)
  requireScreen();await assertTestDisplayWindow(f.pid)
  const stats=await control('stats')
  const footprint=probe(`cycle-${round}-footprint.txt`,'footprint',['-p',String(f.pid)])
  cycles.push({round:round+1,stats,footprint})
  writeFileSync(path.join(out,'cycles.json'),JSON.stringify(cycles,null,2))
 }
 if(process.env.KYBERN_MEMORY_STACKS==='1'){
  const addresses=probe('closed-addresses.txt','heap',['-s','-H','--noContent','--addresses=all',String(f.pid)])
  const pointers=addresses.split('\n').flatMap(line=>line.match(/^\s*(0x[0-9a-f]+)\b/i)?.[1]??[]).slice(0,6)
  for(const [i,pointer] of pointers.entries()){
   probe(`closed-history-${i}.txt`,'malloc_history',[String(f.pid),'-fullStacks',pointer])
   probe(`closed-owners-${i}.txt`,'leaks',['--noContent','--fullStacks',`--traceTree=${pointer}`,String(f.pid)])
  }
 }
 writeFileSync(path.join(out,'relief.json'),JSON.stringify(await control('allocator-relief'),null,2))
 await Bun.sleep(1000)
 probe('relieved-vmmap.txt','vmmap',['-summary',String(f.pid)])
 probe('relieved-footprint.txt','footprint',['-p',String(f.pid)])
 await control('gc');await Bun.sleep(500)
 writeFileSync(path.join(out,'gc-stats.json'),JSON.stringify(await control('stats'),null,2))
 probe('gc-footprint.txt','footprint',['-p',String(f.pid)])
 if(process.env.KYBERN_MEMORY_SNAPSHOTS==='1'){
  const {file}=await control('snapshot',{kind:'gc'}) as {file:string};copyFileSync(file,path.join(out,'gc.heapsnapshot'))
 }
} finally {log=f.diagnostics();writeFileSync(path.join(out,'native.log'),log);await f.close();release()}
