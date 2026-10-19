// Reuse the task/project interaction driver with this lane's capture gates.
import {readFileSync} from 'node:fs'
Bun.plugin({name:'flick-task-interactions',setup(build){
 build.onLoad({filter:/\/src\/tasks\/round7b-check\.ts$/},args=>{
  let source=readFileSync(args.path,'utf8')
  const start=source.indexOf('async function sample(name:string) {'),end=source.indexOf('const wait=',start)
  if(start<0||end<0||!source.includes('const shot=(file:string)=>{'))throw Error('Task interaction anchors moved')
  // These checks establish behavior and motion states. The paired bench owns
  // resources; do not emit misleading resource samples during another build.
  source=source.slice(0,start)+"async function sample(name:string) { return {done:async()=>{writeFileSync(out+'/'+label+'-'+name+'-resources.json',JSON.stringify({timingEvidence:false,reason:'Interaction-only run; paired bench measures resources'}))}} }\n"+source.slice(end)
  source="import {requireWindowOnscreen,waitForWindowOnscreen} from '../../perf/bench/window-onscreen.ts'\n"+source
  source=source.replace('const shot=(file:string)=>{','const shot=(file:string)=>{requireWindowOnscreen(fixture.pid);')
  source=source.replace(" await app.getByTestId('app-ready').waitFor({timeoutMs:60000})"," await app.getByTestId('app-ready').waitFor({timeoutMs:60000});await waitForWindowOnscreen(fixture.pid)")
  return {contents:source,loader:'ts'}
 })
}})
await import('../../src/tasks/round7b-check.ts')
