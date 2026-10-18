import {mkdirSync,writeFileSync,existsSync,readFileSync} from 'node:fs'
const out='/Users/mymac/projects/ade/previews/gpuix/perf/cadence/diagnostics'
mkdirSync(out,{recursive:true})
const hasher=new Bun.CryptoHasher('sha256')
const files=[...new Bun.Glob('{src,perf/bench,perf/cadence}/**/*.{ts,tsx,m,py}').scanSync('.')].sort()
for(const file of [...files,'tsconfig.json','native/tsconfig.json','perf/bench/tsconfig.json','perf/cadence/tsconfig.json'])hasher.update(file).update(await Bun.file(file).arrayBuffer())
const sourceHash=hasher.digest('hex'),stamp=`${out}/source-validation.json`
const prior=existsSync(stamp)?JSON.parse(readFileSync(stamp,'utf8')):null
if(prior?.sourceHash!==sourceHash)for(const command of [
 ['python3','perf/cadence/analyze.py'],
 ['pnpm','typecheck'],['pnpm','exec','tsc','-p','native/tsconfig.json'],
 ['pnpm','exec','tsc','-p','perf/bench/tsconfig.json'],['pnpm','exec','tsc','-p','perf/cadence/tsconfig.json'],
 ['bun','test','./src'],['bun','test','perf/bench/model.test.ts'],
 ['clang','-fobjc-arc','-framework','AppKit','-framework','CoreGraphics','perf/bench/wheel-check.m','-o',`${out}/wheel-check`],
 [`${out}/wheel-check`],
]){
 const child=Bun.spawn(command,{stdout:'pipe',stderr:'pipe'})
 const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
 writeFileSync(`${out}/${command.join('-').replaceAll(/[^\w.-]/g,'_').slice(0,100)}.log`,stdout+stderr)
 if(code)throw Error(`${command.join(' ')} failed ${code}: ${(stdout+stderr).slice(-5000)}`)
 console.log(`PASS ${command.join(' ')}`)
}
writeFileSync(stamp,JSON.stringify({sourceHash,passed:true,at:new Date().toISOString()},null,2))
if(process.env.CADENCE_SOURCE_CHECKS_ONLY==='1')process.exit(0)
process.env.CADENCE_HEADLESS_LEASE_TEST='1'
// No UI launches: verify real queue/lock cleanup on normal signals, crash and
// uncatchable SIGKILL. This runs in our own quiet window before resource tests.
const queue='/tmp/kybern-gpuix-ui-queue',lock='/tmp/kybern-gpuix-round5-ui-lock'
const until=async(check:()=>boolean)=>{const deadline=Date.now()+10000;while(!check()){if(Date.now()>deadline)throw Error('Lease cleanup timed out');await Bun.sleep(50)}}
const results=[]
for(const mode of ['SIGTERM','SIGKILL','crash'] as const){
 const child=Bun.spawn(['bun','perf/cadence/lease-child.ts'],{env:{...process.env,CADENCE_LEASE_CRASH:mode==='crash'?'1':'0'},stdout:'pipe',stderr:'pipe'})
 const reader=child.stdout.getReader(),first=await reader.read();reader.releaseLock()
 if(!new TextDecoder().decode(first.value).includes('acquired'))throw Error('Lease child did not acquire')
 if(mode!=='crash')child.kill(mode)
 await child.exited
 await until(()=>!existsSync(lock)&&!readFileSync(queue,'utf8').includes(`perf-bench-${child.pid}`))
 results.push({mode,passed:true});writeFileSync(`${out}/lease-cleanup.json`,JSON.stringify(results,null,2))
}
// Queued SIGKILL must not remove the still-live holder's lock.
const {lease}=await import('../bench/lease.ts'),release=await lease()
try{
 const child=Bun.spawn(['bun','perf/cadence/lease-child.ts'],{env:{...process.env,CADENCE_HEADLESS_LEASE_TEST:'1'},stdout:'pipe',stderr:'pipe'})
 await until(()=>readFileSync(queue,'utf8').includes(`perf-bench-${child.pid}`));child.kill('SIGKILL');await child.exited
 await until(()=>!readFileSync(queue,'utf8').includes(`perf-bench-${child.pid}`))
 if(!existsSync(lock))throw Error('Queued cleanup removed another live lease')
 results.push({mode:'queued SIGKILL preserves live owner',passed:true})
}finally{release()}
writeFileSync(`${out}/lease-cleanup.json`,JSON.stringify(results,null,2))
console.log('PASS lease crash/kill/queue cleanup')
const {rmSync}=await import('node:fs')
const directory='/Users/mymac/projects/ade-gpuix-scratch/perf-cadence-guardian-test'
mkdirSync(directory,{recursive:true})
const quietResults=[]
try{
 for(const mode of ['SIGTERM','SIGKILL','timeout','crash','queued SIGKILL']){
  const lane='guardian-test',q=`${directory}/kybern-gpuix-quiet.${lane}`,order=`${directory}/kybern-gpuix-quiet-order`,pidfile=`${directory}/pids.json`
  rmSync(pidfile,{force:true});writeFileSync(order,mode==='queued SIGKILL'?'another-test\n':'')
  const script=mode==='crash'?"process.exit(7)":`const kid=Bun.spawn(['sleep','60'],{stdout:'ignore',stderr:'ignore'});await Bun.write(${JSON.stringify(pidfile)},JSON.stringify([process.pid,kid.pid]));await Bun.sleep(60000)`
  const child=Bun.spawn(['bun','perf/cadence/quiet.ts','bun','-e',script],{env:{...process.env,CADENCE_COORDINATION_DIR:directory,CADENCE_QUIET_LANE:lane,CADENCE_MAX_SECONDS:mode==='timeout'?'1':'10'},stdout:'pipe',stderr:'pipe'})
  if(mode==='queued SIGKILL'){
   await until(()=>readFileSync(order,'utf8').includes(lane));child.kill('SIGKILL')
  }else if(mode==='SIGTERM'||mode==='SIGKILL'){
   await until(()=>existsSync(pidfile));child.kill(mode)
  }
  await child.exited
  await until(()=>!existsSync(q)&&!readFileSync(order,'utf8').split('\n').includes(lane))
  if(existsSync(pidfile))for(const pid of JSON.parse(readFileSync(pidfile,'utf8'))){
   await until(()=>{try{process.kill(pid,0);return false}catch(e){return (e as NodeJS.ErrnoException).code==='ESRCH'}})
  }
  quietResults.push({mode,passed:true})
 }
}finally{rmSync(directory,{recursive:true,force:true})}
writeFileSync(`${out}/quiet-cleanup.json`,JSON.stringify(quietResults,null,2))
console.log('PASS quiet wrapper crash/kill/timeout descendants and queue cleanup')

delete process.env.CADENCE_HEADLESS_LEASE_TEST
