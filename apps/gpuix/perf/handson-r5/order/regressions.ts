// Reuse the established interaction checks, isolating all scratch/evidence paths.
import {readFileSync} from 'node:fs'
import path from 'node:path'
const script=path.resolve(process.argv[2]!)
process.argv=[process.argv[0]!,script,...process.argv.slice(3)]
Bun.plugin({name:'hr5-order-regression-paths',setup(build){
 build.onLoad({filter:/\/perf\/(?:scroll2|flick)\/.*\.tsx?$/},args=>{
  const source=readFileSync(args.path,'utf8')
    .replaceAll('/Users/mymac/projects/ade/previews/gpuix/perf/scroll2','/Users/mymac/projects/ade/previews/gpuix/handson-r5/order/scroll2')
    .replaceAll('/Users/mymac/projects/ade/previews/gpuix/perf/flick','/Users/mymac/projects/ade/previews/gpuix/handson-r5/order/flick')
    .replaceAll('/Users/mymac/projects/ade-gpuix-scratch/perf-scroll2','/Users/mymac/projects/ade-gpuix-scratch/hr5-order-scroll2')
    .replaceAll('/Users/mymac/projects/ade-gpuix-scratch/perf-flick-follow','/Users/mymac/projects/ade-gpuix-scratch/hr5-order-flick-follow')
  return {loader:args.path.endsWith('.tsx')?'tsx':'ts',contents:source}
 })
}})
await import(script)
