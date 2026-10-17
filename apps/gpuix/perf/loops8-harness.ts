import { connectStdio } from '@gpuix/react/automation'
import { spawn } from 'node:child_process'

/** Automation launch with an explicit process lifetime and startup deadline.
 * The upstream launch helper doesn't reject when a child exits before handshake. */
export async function launchFixture(entry: string, env: Record<string, string>) {
  const child = spawn('bun', [entry], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
  const visibilityEvents:{received:number,visible:boolean,line:string}[]=[];let observerReady=false,frontAt=0
  const gpuFrames:{received:number,line:string}[]=[]; let stderr = ''; let renders = 0; let wakes = 0; let commits = 0; let pending = ''; let frames=0; const frameTimes:number[]=[]; const frameEvents:{native:number;received:number}[]=[]
  const regions:string[]=[];const regionEvents:{received:number,line:string}[]=[]
  child.stderr.on('data', chunk => {
    const text = String(chunk)
    stderr = (stderr + text).slice(-2000000)
    pending += text
    const end = pending.lastIndexOf('\n')
    if (end < 0) return
    const lines = pending.slice(0, end + 1)
    for(const line of lines.split('\n')){if(line.includes('[loops-observer-ready]'))observerReady=true;if(line.includes('[loops-front]'))frontAt=performance.now();if(line.includes('[loops-visibility]'))visibilityEvents.push({received:performance.now(),visible:line.includes('visible=1'),line:line.slice(line.indexOf('[loops-visibility]'))});if(line.includes('[paint-region]')){regions.push(line);regionEvents.push({received:performance.now(),line})}if(line.includes('[paint-gpu]'))gpuFrames.push({received:performance.now(),line})}
    pending = pending.slice(end + 1)
    for(const match of lines.matchAll(/\[kybern-frame\] ([0-9.]+)/g)) { frames++;frameTimes.push(Number(match[1]));frameEvents.push({native:Number(match[1]),received:performance.now()});if(frameTimes.length>2048)frameTimes.shift();if(frameEvents.length>2048)frameEvents.shift() }
    commits += (lines.match(/\[idle\] react commit|\[pacing-commit\]/g) ?? []).length
    renders += (lines.match(/\[islands\] render /g) ?? []).length
    wakes += (lines.match(/\[islands\] pre-draw wake /g) ?? []).length
  })
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
    return { app, pid: child.pid!, counts: () => ({renders,wakes,commits,frames}), observerReady:()=>observerReady,frontAt:()=>frontAt,visibilityEvents:()=>[...visibilityEvents],gpuFrames:()=>[...gpuFrames], regionEvents:()=>[...regionEvents], regions:()=>[...regions], frameTimes:()=>[...frameTimes], frameEvents:()=>[...frameEvents], diagnostics: () => stderr, close: async () => { await app.close(); if (child.exitCode === null && child.signalCode === null) { child.kill(); await new Promise<void>(resolve => child.once('exit', () => resolve())) } } }
  } catch (error) { clearTimeout(timer); child.kill(); throw error }
}
