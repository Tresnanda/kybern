// Cover upstream automation launchers as well as local fixture harnesses.
import {App} from '@gpuix/react/automation'
import {waitForWindow,requireWindow} from './window-guard.ts'
const displayProbe=process.env.KYBERN_BUILTIN_DISPLAY_PROBE
if(displayProbe&&Bun.spawnSync([displayProbe],{stdout:'ignore',stderr:'ignore'}).exitCode!==0)throw Error('Hidden test display unavailable; no fixture will launch')
if(process.env.KYBERN_WINDOW_GUARD){
 const screenshot=App.prototype.screenshot
 const pids=new WeakMap<App,number>()
 App.prototype.screenshot=async function(options){
  let pid=pids.get(this)
  if(pid==null){pid=(await this.call('initialize',{protocolVersion:1,client:'backdrop-capture-guard'})).pid;pids.set(this,pid)}
  for(let attempt=0;attempt<3;attempt++){
   await waitForWindow(pid)
   const saved=await screenshot.call(this,options)
   try{requireWindow(pid);return saved}catch(error){if(attempt===2)throw error}
  }
  throw Error('Occluded capture discarded')
 }
}
