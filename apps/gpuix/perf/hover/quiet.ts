// One build-free window, with a bounded owned process group and fair ordering.
import {execFileSync,spawn} from 'node:child_process'
import {existsSync,openSync,closeSync,readFileSync,readdirSync,unlinkSync,writeFileSync} from 'node:fs'
import {screenState} from '../bench/screen-state.ts'
const lane='hr5-hover',order='/tmp/kybern-gpuix-quiet-order',quiet=`/tmp/kybern-gpuix-quiet.${lane}`
const names=(prefix:string)=>readdirSync('/tmp').filter(n=>n.startsWith(prefix))
function edit(action:string){execFileSync('python3',['-c',`import pathlib,sys,fcntl
p=pathlib.Path(sys.argv[1]);p.touch(exist_ok=True)
with p.open('r+') as f:
 fcntl.flock(f,fcntl.LOCK_EX)
 a=[s for s in f.read().splitlines() if s];lane=sys.argv[2]
 if sys.argv[3]=='join' and lane not in a:a.append(lane)
 if sys.argv[3]=='leave':a=[s for s in a if s!=lane]
 f.seek(0);f.write(''.join(s+chr(10) for s in a));f.truncate()
`,order,lane,action])}
const command=process.argv.slice(2);if(!command.length)throw Error('Pass a command')
let owned=false,stopped=false,child:ReturnType<typeof spawn>|undefined
const release=()=>{if(owned&&existsSync(quiet))unlinkSync(quiet);edit('leave')}
// Bun can terminate on an interactive SIGINT before the awaited child-exit
// promise resumes; the synchronous exit hook still removes this lane's marker.
const exitCleanup=()=>{signal('SIGKILL');release()}
process.once('exit',exitCleanup)
const signal=(kind:NodeJS.Signals)=>{if(child?.pid)try{process.kill(-child.pid,kind)}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e}}
for(const kind of ['SIGTERM','SIGINT'] as const)process.once(kind,()=>{stopped=true;signal(kind)})
edit('join')
try{
 while(!stopped&&!owned){
  const first=readFileSync(order,'utf8').split('\n').filter(Boolean)[0]
  if(first===lane&&!existsSync('/tmp/kybern-gpuix-round5-ui-lock')&&!names('kybern-gpuix-quiet-next.').filter(n=>n!==`kybern-gpuix-quiet-next.${lane}`).length&&!names('kybern-gpuix-quiet.').length&&!names('kybern-gpuix-native-build.').length&&!names('kybern-gpuix-build-next.').length){
   if(!screenState().valid){await Bun.sleep(60000);continue}
   try{closeSync(openSync(quiet,'wx'));owned=true;writeFileSync(quiet,`${lane} ${new Date().toISOString()} isolated hover scroll/idle comparison; expected end ${new Date(Date.now()+24*60000).toISOString()}\n`)}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e}
   if(owned&&(existsSync('/tmp/kybern-gpuix-round5-ui-lock')||names('kybern-gpuix-native-build.').length||names('kybern-gpuix-build-next.').length||names('kybern-gpuix-quiet.').some(n=>n!==`kybern-gpuix-quiet.${lane}`))){unlinkSync(quiet);owned=false}
  }
  if(!owned)await Bun.sleep(1000)
 }
 if(!stopped){
  child=spawn(command[0]!,command.slice(1),{env:process.env,stdio:'inherit',detached:true})
  const timeout=setTimeout(()=>{stopped=true;signal('SIGTERM')},24*60000)
  try{process.exitCode=await new Promise<number>((resolve,reject)=>{child!.once('error',reject);child!.once('exit',code=>resolve(stopped?130:code??1))})}finally{clearTimeout(timeout);signal('SIGKILL')}
 }
}finally{
 signal('SIGKILL');process.off('exit',exitCleanup);release()
}
