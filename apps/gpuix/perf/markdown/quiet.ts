import { writeFileSync, unlinkSync, readdirSync, readFileSync, existsSync } from 'node:fs'
const lane='perf-markdown', marker=`/tmp/kybern-gpuix-quiet.${lane}`
const order='/tmp/kybern-gpuix-quiet-order'
function queue(remove=false) {
 const result=Bun.spawnSync(['python3','-c',
  'from pathlib import Path;import sys\np=Path(sys.argv[1]);lane=sys.argv[2];lines=p.read_text().splitlines() if p.exists() else []\nlines=[x for x in lines if x and x!=lane] if sys.argv[3]=="remove" else lines+([] if lane in lines else [lane])\np.write_text("".join(x+chr(10) for x in lines))',
  order,lane,remove?'remove':'append'])
 if(result.exitCode)throw Error(result.stderr.toString())
}
let child: ReturnType<typeof Bun.spawn> | undefined
let ownsMarker=false, stopping=false
const stop=()=>{
 if(stopping)return
 stopping=true
 if(child)child.kill('SIGTERM')
 else {queue(true);process.exit(130)}
}
process.once('SIGINT',stop);process.once('SIGTERM',stop)
let deadline: ReturnType<typeof setTimeout> | undefined
queue()
try {
 while ((existsSync(order)?readFileSync(order,'utf8').split('\n').filter(Boolean)[0]:undefined)!==lane ||
  readdirSync('/tmp').some(name => name.startsWith('kybern-gpuix-native-build.') || name.startsWith('kybern-gpuix-build-next.') || name.startsWith('kybern-gpuix-quiet.') || name.startsWith('kybern-gpuix-quiet-next.'))) await Bun.sleep(500)
 writeFileSync(marker,`${lane} start=${new Date().toISOString()} expected_end=${new Date(Date.now()+25*60_000).toISOString()}\n`)
 ownsMarker=true
 deadline=setTimeout(stop,24*60_000+50_000)
 child=Bun.spawn(process.argv.slice(2),{env:process.env,stdin:'inherit',stdout:'inherit',stderr:'inherit'})
 process.exitCode=await child.exited
} finally {
 if(deadline)clearTimeout(deadline)
 process.off('SIGINT',stop);process.off('SIGTERM',stop)
 if(ownsMarker)unlinkSync(marker)
 queue(true)
}
