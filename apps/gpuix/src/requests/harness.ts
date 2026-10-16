import { connectStdio } from '@gpuix/react/automation'
import { spawn } from 'node:child_process'

/** Automation launch with an explicit process lifetime and startup deadline.
 * The upstream launch helper doesn't reject when a child exits before handshake. */
export async function launchFixture(entry: string, env: Record<string, string>) {
  const child = spawn('bun', [entry], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  const frames:number[]=[]
  let frameRemainder=''
  child.stderr.on('data', chunk => {
    stderr = (stderr + String(chunk)).slice(-8000)
    if(env.KYBERN_FRAME_TIMES==='1') {
      const lines=(frameRemainder+String(chunk)).split('\n');frameRemainder=lines.pop()??''
      for(const line of lines){const m=line.match(/\[kybern-frame\] ([\d.]+)/);if(m)frames.push(Number(m[1]))}
      if(frames.length>10000)frames.splice(0,frames.length-10000)
    }
    if(process.env.KYBERN_FIXTURE_DIAGNOSTICS) process.stderr.write(chunk)
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
    // An addon panic after handshake must reject pending input, rather than
    // leave a live test waiting forever on a dead transport.
    const exited = new Promise<never>((_,reject)=>child.once('exit',code=>reject(new Error(`Fixture exited (${code}): ${stderr}`))))
    void exited.catch(()=>{})
    const backend=(app as unknown as {backend:{call:(...args:unknown[])=>Promise<unknown>}}).backend
    const call=backend.call.bind(backend)
    backend.call=(...args)=>Promise.race([call(...args),exited])
    return { app, pid: child.pid!, diagnostics: () => stderr, frameTimes:()=>[...frames], close: async () => {
      let deadline:ReturnType<typeof setTimeout>|undefined
      try { await Promise.race([app.close(),new Promise(resolve=>{deadline=setTimeout(resolve,2000)})]) }
      finally {
        clearTimeout(deadline)
        if(child.exitCode===null){
          child.kill()
          await new Promise<void>(resolve=>{const done=()=>{clearTimeout(deadline);resolve()};child.once('exit',done);deadline=setTimeout(()=>{child.kill('SIGKILL');done()},2000)})
        }
      }
    } }
  } catch (error) { clearTimeout(timer); child.kill(); throw error }
}

/** Wait for formatted native output. The renderer can also report clipped text,
 * so screenshots remain necessary to check visibility and wrapping. */
export async function waitForPainted(app: Awaited<ReturnType<typeof connectStdio>>, text: string, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await app.call('getPaintedText', {})).text.join('\n').includes(text)) return
    await app.clock.fastForward(32)
  }
  throw new Error(`Timed out waiting for painted text: ${text}`)
}
