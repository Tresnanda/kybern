import { connectStdio } from '@gpuix/react/automation'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'

/** Aborts a launch whose data directory is (or falls back to) the user's real `~/.kybern`: a GPUIX start can restart the daemon found there. */
export function assertScratchEnv(env: Record<string, string | undefined>) {
  const merged = { ...process.env, ...env }
  const dir = merged.KYBERN_DATA_DIR
  const real = path.join(homedir(), '.kybern')
  if (!dir) throw Error('Refusing to launch GPUIX without KYBERN_DATA_DIR: it would resolve the real ~/.kybern daemon. Point it at a scratch directory.')
  const resolved = path.resolve(dir)
  if (resolved === real || resolved.startsWith(real + path.sep)) throw Error(`Refusing to launch GPUIX against the real data directory ${real}. Use a scratch directory.`)
  // An endpoint inherited from the calling shell (an agent running inside Kybern) could be the user's own daemon.
  // An explicit empty value clears it for the child, so only a missing key is inherited.
  if (process.env.KYBERN_URL && env.KYBERN_URL === undefined) throw Error('Refusing to launch GPUIX with a KYBERN_URL inherited from this shell: it may be the real daemon. Unset it, or pass the scratch endpoint explicitly.')
}

/** Automation launch with an explicit process lifetime and startup deadline.
 * The upstream launch helper doesn't reject when a child exits before handshake. */
export async function launchFixture(entry: string, env: Record<string, string>) {
  assertScratchEnv(env)
  // Without a client config dir GPUIX would read the desktop's saved environments and write its own prefs under ~/Library.
  const clientDir = process.env.KYBERN_CLIENT_CONFIG_DIR ?? path.join(path.resolve(({ ...process.env, ...env }).KYBERN_DATA_DIR!), 'client-config')
  const child = spawn('bun', [entry], { env: { KYBERN_CLIENT_CONFIG_DIR: clientDir, ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
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
