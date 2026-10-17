// Resource-only entry point. Observe only this process's own window; the user
// may be active on the machine while background native measurements run.
import type {Pointer} from 'bun:ffi'
await import('./pacing-app.ts')
const {each,getObjc,nsApp,sel}=await import('../src/native/objc.ts')
const o=getObjc(),app=nsApp()
function observe(){
 if(!app)return
 let windows=0,visible=false,minimized=false,state=0
 each(o,o.msg(app,sel(o,'windows')) as Pointer,window=>{
  if((Number(o.msgU64(window,sel(o,'canBecomeMainWindow')))&0xff)===0)return
  const mini=(Number(o.msgU64(window,sel(o,'isMiniaturized')))&0xff)!==0
  const shown=(Number(o.msgU64(window,sel(o,'isVisible')))&0xff)!==0
  if(!shown&&!mini)return
  windows++;const occlusion=Number(o.msgU64(window,sel(o,'occlusionState')))
  state|=occlusion;minimized ||= mini;visible ||= shown&&!mini&&(occlusion&2)!==0
 })
 console.error(`[loops-visibility] visible=${Number(visible)} state=${state} minimized=${Number(minimized)} windows=${windows}`)
}
process.on('SIGUSR1',()=>{
 if(app)each(o,o.msg(app,sel(o,'windows')) as Pointer,window=>{
  if((Number(o.msgU64(window,sel(o,'canBecomeMainWindow')))&0xff)===0)return
  if((Number(o.msgU64(window,sel(o,'isVisible')))&0xff)===0)return
  o.msgSetI64(window,sel(o,'setLevel:'),3n)
  o.msg(window,sel(o,'orderFrontRegardless'))
 })
 console.error('[loops-front]')
 observe()
})
observe()
setInterval(observe,100)
console.error('[loops-observer-ready]')
