// Run existing correctness assertions with this lane's own scratch/evidence paths.
import path from 'node:path'
import {readFileSync} from 'node:fs'
const script=path.resolve(process.argv[2]!)
process.argv=[process.argv[0]!,script,...process.argv.slice(3)]
Bun.plugin({name:'flick-evidence-paths',setup(build){
 build.onLoad({filter:/\/perf\/scroll2\/.*\.tsx?$/},args=>({contents:readFileSync(args.path,'utf8').replaceAll('/Users/mymac/projects/ade/previews/gpuix/perf/scroll2','/Users/mymac/projects/ade/previews/gpuix/perf/flick/checks').replaceAll('/Users/mymac/projects/ade-gpuix-scratch/perf-scroll2','/Users/mymac/projects/ade-gpuix-scratch/perf-flick-checks'),loader:args.path.endsWith('.tsx')?'tsx':'ts'}))
}})
await import(script)
