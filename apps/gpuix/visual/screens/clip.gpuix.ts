import {park,type Step} from '../screens.gpuix.ts'
import {openDock,absent} from '../../scripts/dock-waits.ts'
import {mkdirSync,writeFileSync} from 'node:fs'
import path from 'node:path'
const workspace=(sidebar:boolean,dock:boolean):Step=>async(a,fx)=>{
 await a.getByTestId(`thread-${fx.extra.clip!.thread}`).click();await a.getByTestId('composer').waitFor()
 if(dock){if(!await a.getByTestId('dock-tabs').count())await a.getByTestId('dock-toggle').click();await openDock(a.getByTestId('right-dock'))}
 if(!sidebar){await a.getByTestId('sidebar-toggle').click();await absent(a.getByTestId(`thread-${fx.extra.clip!.thread}`))}
 await park(a)
}
export const screens:Record<string,Step>={
 'clip-sidebar-dock':workspace(true,true),'clip-sidebar':workspace(true,false),
 'clip-dock':workspace(false,true),'clip-closed':workspace(false,false),
 'clip-split':async(a,fx)=>{await workspace(true,false)(a,fx);await a.getByTestId('app-ready').press('cmd-\\');await park(a)},
 'clip-narrow':workspace(true,true),
 'clip-code-horizontal':async(a,fx)=>{await workspace(false,false)(a,fx);const nodes=await a.getByTestId('code-body').all(),b=(await a.call('getBounds',{elementId:nodes.at(-1)!.id})).bounds!;await a.mouse.wheel({x:b.x+b.width/2,y:b.y+b.height/2},-240,0);await park(a)},
 'clip-code-wrapped':async(a,fx)=>{await workspace(false,false)(a,fx);const nodes=await a.getByTestId('code-wrap').all(),b=(await a.call('getBounds',{elementId:nodes.at(-1)!.id})).bounds!;await a.mouse.click({x:b.x+b.width/2,y:b.y+b.height/2});await park(a)},
 'clip-panel-motion':async(a,fx)=>{
  await workspace(true,false)(a,fx);await a.clock.pause();await a.clock.set(0);await a.getByTestId('sidebar-toggle').click()
  await a.mouse.move({x:1275,y:815})
  const dir=path.join(process.env.KYBERN_VERIFY_OUTPUT!,`panel-${process.env.KYBERN_VERIFY_THEME}-gpuix`)
  mkdirSync(dir,{recursive:true});const geometry=[]
  for(const time of [0,40,80,140,220,320]){await a.clock.set(time);await a.screenshot({path:path.join(dir,`t${time}.png`)});geometry.push({time,composer:await a.getByTestId('composer').bounds()})}
  writeFileSync(path.join(dir,'geometry.json'),JSON.stringify(geometry,null,2))
  if(process.env.KYBERN_REDUCED_MOTION==='0'&&Math.abs(geometry[0]!.composer.x-geometry.at(-1)!.composer.x)<10)throw Error('Native strip did not contain sidebar movement')
 },
}
export const entries={'clip-narrow':{entry:'src/main.tsx',env:{KYBERN_WINDOW_SIZE:'920x820'}}}
for(const name of Object.keys(screens)){
 const step=screens[name]!
 screens[name]=async(a,fx)=>{
  await step(a,fx)
  if(!process.env.KYBERN_VERIFY_OUTPUT)return
  const boxes=async(id:string)=>Promise.all((await a.getByTestId(id).all()).map(async n=>(await a.call('getBounds',{elementId:n.id})).bounds))
  const data={window:await a.getByTestId('app-ready').bounds(),workspace:await a.getByTestId('workspace-card').bounds(),codeHeaders:await boxes('code-header'),codeBodies:await boxes('code-body')}
  mkdirSync(process.env.KYBERN_VERIFY_OUTPUT,{recursive:true});writeFileSync(path.join(process.env.KYBERN_VERIFY_OUTPUT,`${name}-${process.env.KYBERN_VERIFY_THEME}-gpuix-bounds.json`),JSON.stringify(data,null,2))
 }
}
