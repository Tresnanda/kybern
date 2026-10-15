import { connectStdio } from '@gpuix/react/automation'
import { spawn } from 'node:child_process'
import path from 'node:path'
export async function launchFixture(_entry: string, env: Record<string,string>) {
 const start = performance.now()
 const executable = path.resolve(import.meta.dir, '../dist/Kybern GPUIX.app/Contents/MacOS/Kybern GPUIX')
 const child = spawn(executable, [], {env:{...process.env,...env}, stdio:['pipe','pipe','pipe']})
 let stderr = ''; child.stderr.on('data', c => {stderr += c; console.error(String(c).trim())})
 let timer: ReturnType<typeof setTimeout>
 const app = await Promise.race([
 connectStdio({write:chunk=>{child.stdin.write(chunk)},feed:listener=>{child.stdout.on('data',chunk=>listener(String(chunk)))},close:async()=>{child.kill()}}),
 new Promise<never>((_,reject)=>{timer=setTimeout(()=>{child.kill();reject(Error(stderr || 'Startup timeout'))},45000);child.once('exit',code=>reject(Error(`App exited ${code}: ${stderr}`)))})
 ])
 clearTimeout(timer!)
 await app.getByTestId('app-ready').waitFor({timeoutMs:45000})
 console.log('bundle app-ready ms:',(performance.now()-start).toFixed(0))
 return {app,pid:child.pid!,diagnostics:()=>stderr,close:async()=>{await app.close();child.kill()}}
}
