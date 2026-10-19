import {waitForWindow,requireWindow} from '../../perf/backdrop/window-guard.ts'
import {appendFileSync,existsSync,readdirSync,readFileSync,writeFileSync} from 'node:fs'
import { connectStdio } from '@gpuix/react/automation'
import { spawn } from 'node:child_process'

/** Automation launch with an explicit process lifetime and startup deadline.
 * The upstream launch helper doesn't reject when a child exits before handshake. */
export async function launchFixture(entry: string, env: Record<string, string>) {
  const child = spawn('bun', [entry], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = '', pendingLine = '', islandRenders = 0
  child.stderr.on('data', chunk => { const text=String(chunk);pendingLine+=text;const end=pendingLine.lastIndexOf('\n');if(end>=0){islandRenders+=(pendingLine.slice(0,end+1).match(/\[islands\] render /g)??[]).length;pendingLine=pendingLine.slice(end+1)}stderr = (stderr + text).slice(-8000); if(process.env.R7_LOG)appendFileSync(process.env.R7_LOG,chunk) })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const app = await Promise.race([
      connectStdio({ write: chunk => { child.stdin.write(chunk) }, feed: listener => { child.stdout.on('data', chunk => listener(String(chunk))) }, close: async () => { child.kill() } }),
      new Promise<never>((_, reject) => {
        child.once('error', reject)
        child.once('exit', code => reject(new Error(`Fixture exited (${code}): ${stderr}`)))
        timer = setTimeout(() => reject(new Error(`Fixture startup timed out: ${stderr}`)), 45000)
      }),
    ])
    clearTimeout(timer)
    if(process.env.KYBERN_WINDOW_GUARD){
      const screenshot=app.screenshot.bind(app)
      app.screenshot=async (...args:Parameters<typeof screenshot>)=>{
        for(let attempt=0;attempt<3;attempt++){
          await waitForWindow(child.pid!)
          const result=await screenshot(...args)
          try{requireWindow(child.pid!);return result}catch(error){if(attempt===2)throw error}
        }
        throw Error('Occluded capture discarded')
      }
    }
    return { app, pid: child.pid!, diagnostics: () => stderr, islandRenders: () => islandRenders, close: async () => { await app.close(); if (child.exitCode === null) child.kill() } }
  } catch (error) { clearTimeout(timer); child.kill(); throw error }
}


/** Each visual/carry fixture starts from the same sidebar order. */
export function resetDragPreferences(data:string) {
  writeFileSync(`${data}/gpuix-ui.json`,'{}')
  const dir=`${data}/client`
  if(!existsSync(dir))return
  for(const file of readdirSync(dir).filter(name=>/^workspace-.*\.json$/.test(name))){
    const name=`${dir}/${file}`,value=JSON.parse(readFileSync(name,'utf8'))
    value.projectOrder=[];writeFileSync(name,JSON.stringify(value))
  }
}
