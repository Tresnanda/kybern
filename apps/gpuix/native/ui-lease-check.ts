import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
const output='/Users/mymac/projects/ade/previews/gpuix/perf/memory/ui-lease-children.json'
rmSync(output,{force:true})
const lane=`perf-memory-lease-check-${process.pid}`
const code=`const child=Bun.spawn(['sleep','60']);require('fs').writeFileSync(${JSON.stringify(output)},JSON.stringify({parent:process.pid,child:child.pid}));setInterval(()=>{},1000)`
const child=Bun.spawn(['bun',path.join(import.meta.dir,'ui-lease.ts'),lane,'bun','-e',code],{stdout:'inherit',stderr:'inherit'})
try {
 const deadline=Date.now()+15*60_000
 while(!existsSync(output)){assert.ok(Date.now()<deadline,'UI lease wait');await Bun.sleep(100)}
 const pids=JSON.parse(readFileSync(output,'utf8')) as {parent:number;child:number}
 child.kill('SIGTERM')
 assert.equal(await child.exited,130)
 const running=(pid:number)=>{try{process.kill(pid,0);return true}catch{return false}}
 for(let i=0;i<100&&(running(pids.parent)||running(pids.child));i++)await Bun.sleep(20)
 assert.equal(running(pids.parent),false,'command survived its lease wrapper')
 assert.equal(running(pids.child),false,'grandchild survived its lease wrapper')
 assert.ok(!readFileSync('/tmp/kybern-gpuix-ui-queue','utf8').split('\n').includes(lane))
 console.log('ok UI lease interruption: command and grandchild stopped; own queue line and lock released')
 const normal=Bun.spawn(['bun',path.join(import.meta.dir,'ui-lease.ts'),lane,'bun','-e','process.exit(0)'],{stdout:'inherit',stderr:'inherit'})
 assert.equal(await normal.exited,0,'normal exit must survive empty process-group cleanup')
 assert.ok(!readFileSync('/tmp/kybern-gpuix-ui-queue','utf8').split('\n').includes(lane))
 console.log('ok UI lease normal exit: empty process group cleaned up and lease released')
} finally {child.kill('SIGTERM')}
