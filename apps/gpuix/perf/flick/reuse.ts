// Run existing correctness assertions with this lane's own scratch/evidence paths.
import path from 'node:path'
import {readFileSync} from 'node:fs'
const script=path.resolve(process.argv[2]!)
process.argv=[process.argv[0]!,script,...process.argv.slice(3)]
Bun.plugin({name:'flick-evidence-paths',setup(build){
 build.onLoad({filter:/\/perf\/scroll2\/.*\.tsx?$/},args=>{
  let source=readFileSync(args.path,'utf8').replaceAll('/Users/mymac/projects/ade/previews/gpuix/perf/scroll2','/Users/mymac/projects/ade/previews/gpuix/perf/flick/checks').replaceAll('/Users/mymac/projects/ade-gpuix-scratch/perf-scroll2','/Users/mymac/projects/ade-gpuix-scratch/perf-flick-checks')
  if(args.path.endsWith('/sidebar.ts')){
   const anchor="  await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })"
   if(!source.includes(anchor))throw Error('Sidebar readiness anchor moved')
   source="import {requireWindowOnscreen,waitForWindowOnscreen} from '../bench/window-onscreen.ts'\n"+source.replace(anchor,anchor+"\n  await waitForWindowOnscreen(child.pid!)\n  const capture=app.screenshot.bind(app);app.screenshot=async options=>{requireWindowOnscreen(child.pid!);return capture(options)}")
  }
  return {contents:source,loader:args.path.endsWith('.tsx')?'tsx':'ts'}
 })
}})
await import(script)
