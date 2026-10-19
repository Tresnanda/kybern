import { writeFileSync, unlinkSync, readdirSync, readFileSync, existsSync } from 'node:fs'
const lane='perf-backdrop', marker=`/tmp/kybern-gpuix-quiet.${lane}`
const order='/tmp/kybern-gpuix-quiet-order'
const screenScript='/Users/mymac/projects/ade-gpuix-scratch/screen-state.swift'
function ready(){const result=Bun.spawnSync(['swift',screenScript],{stdout:'pipe',stderr:'pipe'});const raw=result.stdout.toString();return result.exitCode===0&&/locked:\s*0\b/.test(raw)&&/displayAsleep:\s*(?:false|0)\b/.test(raw)}
function queue(remove=false) {
 const result=Bun.spawnSync(['python3','-c',
  `from pathlib import Path
import sys,fcntl
p=Path(sys.argv[1]);p.touch(exist_ok=True)
with p.open('r+') as f:
 fcntl.flock(f,fcntl.LOCK_EX)
 lane=sys.argv[2];lines=[x for x in f.read().splitlines() if x]
 if sys.argv[3]=='remove':lines=[x for x in lines if x!=lane]
 elif lane not in lines:lines.append(lane)
 f.seek(0);f.write(''.join(x+chr(10) for x in lines));f.truncate()
`,order,lane,remove?'remove':'append'])
 if(result.exitCode)throw Error(result.stderr.toString())
}
let child: ReturnType<typeof Bun.spawn> | undefined
let awake: ReturnType<typeof Bun.spawn> | undefined
let ownsMarker=false, stopping=false
const stop=()=>{
 if(stopping)return
 stopping=true
 if(child)child.kill('SIGTERM')
 else {if(ownsMarker){unlinkSync(marker);ownsMarker=false}queue(true);process.exit(130)}
}
process.once('SIGINT',stop);process.once('SIGTERM',stop)
let deadline: ReturnType<typeof setTimeout> | undefined
queue()
try {
 for(;;){
  if((existsSync(order)?readFileSync(order,'utf8').split('\n').filter(Boolean)[0]:undefined)!==lane || readdirSync('/tmp').some(name=>['kybern-gpuix-native-build.','kybern-gpuix-build-next.','kybern-gpuix-quiet.','kybern-gpuix-quiet-next.'].some(prefix=>name.startsWith(prefix)))){await Bun.sleep(500);continue}
  if(!ready()){await Bun.sleep(60000);continue}
  // Screen-state evaluation takes time. Recheck the shared slot before and
  // after publication so a concurrent reservation cannot start a timed run.
  if(readdirSync('/tmp').some(name=>['kybern-gpuix-native-build.','kybern-gpuix-build-next.','kybern-gpuix-quiet.'].some(prefix=>name.startsWith(prefix))))continue
  writeFileSync(marker,`${lane} start=${new Date().toISOString()} expected_end=${new Date(Date.now()+25*60_000).toISOString()}\n`)
  ownsMarker=true
  if(readdirSync('/tmp').some(name=>['kybern-gpuix-native-build.','kybern-gpuix-build-next.'].some(prefix=>name.startsWith(prefix)))){unlinkSync(marker);ownsMarker=false;await Bun.sleep(500);continue}
  await Bun.sleep(300)
  if(readdirSync('/tmp').some(name=>['kybern-gpuix-native-build.','kybern-gpuix-build-next.'].some(prefix=>name.startsWith(prefix)))){unlinkSync(marker);ownsMarker=false;await Bun.sleep(500);continue}
  break
 }
 // Process-local NSEvents do not reset macOS's display-idle timer. A sleeping
 // display can keep the retained tree active while no Metal frames submit.
 awake=Bun.spawn(['/usr/bin/caffeinate','-d','-w',String(process.pid),'-t','1500'],{stdout:'ignore',stderr:'ignore'})
 deadline=setTimeout(stop,24*60_000+50_000)
 child=Bun.spawn(process.argv.slice(2),{env:{...process.env,KYBERN_BENCH_SCREEN_STATE_SCRIPT:screenScript},stdin:'inherit',stdout:'inherit',stderr:'inherit'})
 process.exitCode=await child.exited
} finally {
 if(deadline)clearTimeout(deadline)
 if(awake){awake.kill();await awake.exited}
 process.off('SIGINT',stop);process.off('SIGTERM',stop)
 if(ownsMarker)unlinkSync(marker)
 queue(true)
}
