// Final short rebuild/check runner. Prepare cold compilation outside the UI
// lease first; acquire before launching so packaging cannot outrun SIGSTOP.
import {spawn} from 'node:child_process'
import {pacingLock} from './scroll8-lock.ts'
import {existsSync,renameSync,appendFileSync} from 'node:fs'
import path from 'node:path'
const app=path.resolve(import.meta.dir,'..'),root=path.resolve(app,'../..')
const addon=path.join(app,'native/build/gpuix-native.darwin-arm64.node')
const log='/Users/mymac/projects/ade/previews/gpuix/round8/scroll/native-update.log'
const release=await pacingLock()
if(existsSync(addon))renameSync(addon,path.join(app,'native/build/previous-round8.node'))
const child=spawn('sh',['native/update.sh'],{cwd:app,env:{...process.env,GPUIX_BACKGROUND:'1',KYBERN_PACING_PARENT_LEASE:root},stdio:['ignore','pipe','pipe']})
const output=(chunk:Buffer)=>{
 const text=chunk.toString();appendFileSync(log,text);process.stdout.write(text)

}
child.stdout.on('data',output);child.stderr.on('data',output)
try{process.exitCode=await new Promise<number>(resolve=>child.once('exit',code=>resolve(code??1)))}finally{release()}
