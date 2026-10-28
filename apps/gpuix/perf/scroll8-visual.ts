// Separate capture-only run. Never mix addon screenshot requests with timing.
import {launchFixture} from '../src/requests/harness.ts'
import {actionFixture} from '../src/pulls/verify.fixture.ts'
import {pacingLock} from './scroll8-lock.ts'
import path from 'node:path'
const theme=process.argv[2]??'dark',reduced=process.argv[3]??'0'
const release=await pacingLock(),fixture=actionFixture({long:true})
const out='/Users/mymac/projects/ade/previews/gpuix/round8/scroll'
try{
 const f=await launchFixture(path.join(import.meta.dir,'pacing-app.ts'),{...fixture.env,KYBERN_APPEARANCE:theme,KYBERN_REDUCED_MOTION:reduced,KYBERN_FULL_RATE:'1'})
 try{
  const a=f.app;await a.getByTestId('app-ready').waitFor();await a.getByTestId('rail-pulls').click();await a.getByTestId('pr-row-108').waitFor()
  for(const scene of ['list','summary','changes','timeline']){
   if(scene==='summary'){await a.getByTestId('pr-row-108').click();await a.getByTestId('pr-summary').waitFor()}
   if(scene==='changes'||scene==='timeline'){await a.getByTestId(`pr-tab-${scene}`).click();await a.getByTestId(scene==='changes'?'pr-native-diff':'pr-select-r1').waitFor()}
   await a.clock.pause();await a.clock.fastForward(1000);
   const b=await a.getByTestId('page-pulls').bounds();await a.mouse.move({x:b.x+b.width/2,y:b.y+b.height/2})
   await a.screenshot({path:`${out}/${process.env.SCROLL8_VISUAL_LABEL??'app'}-${theme}-${reduced}-${scene}.png`})
  }
 }catch(error){console.error(f.diagnostics());throw error}finally{await f.close()}
}finally{fixture.close();release()}
