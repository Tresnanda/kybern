import { connectStdio } from '@gpuix/react/automation'
import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/** A GPUIX launch must never resolve the user's real `~/.kybern`: startup restarts a
 * daemon whose binary looks newer, which killed every running agent once. Aborts
 * unless the data dir is explicitly a scratch one outside `~/.kybern`, and refuses a
 * `KYBERN_URL` inherited from the calling shell (an agent running inside Kybern), which
 * may be the user's own daemon. Callers clear it with `KYBERN_URL: ''`. */
export function assertScratchEnv(env: Record<string, string | undefined>) {
  const merged = { ...process.env, ...env }
  const canonical = (dir: string) => { try { return realpathSync(dir) } catch { return path.resolve(dir) } }
  // The real directory itself is never touched, not even by a stat: only the home folder is resolved.
  const home = process.env.HOME || homedir()
  const reals = [path.join(home, '.kybern'), path.join(canonical(home), '.kybern')]
  if (process.env.KYBERN_URL && !('KYBERN_URL' in env)) throw new Error('Refusing to launch GPUIX with a KYBERN_URL inherited from this shell: it may be the real daemon. Pass the scratch endpoint explicitly, or KYBERN_URL: \'\' to clear it.')
  const dir = merged.KYBERN_DATA_DIR
  if (!dir) throw new Error('Refusing to launch GPUIX without KYBERN_DATA_DIR: it would resolve the real ~/.kybern daemon. Point it at a scratch directory.')
  const inside = (candidate: string) => reals.some(real => candidate === real || candidate.startsWith(real + path.sep))
  if (inside(path.resolve(dir)) || inside(canonical(dir))) throw new Error(`Refusing to launch GPUIX against the real data directory ${reals[0]}. Use a scratch directory.`)
}

/** Automation launch with an explicit process lifetime and startup deadline.
 * The upstream launch helper doesn't reject when a child exits before handshake. */
export async function launchFixture(entry: string, env: Record<string, string>, observe?: { stderr?: (chunk: string) => void }) {
  assertScratchEnv(env)
  // Without a client config dir GPUIX would read the desktop's saved environments and write its own prefs under ~/Library.
  const clientDir = process.env.KYBERN_CLIENT_CONFIG_DIR ?? path.join(path.resolve(({ ...process.env, ...env }).KYBERN_DATA_DIR!), 'client-config')
  const child = spawn('bun', [entry], { env: { KYBERN_CLIENT_CONFIG_DIR: clientDir, ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  const frames:number[]=[]
  let frameRemainder=''
  child.stderr.on('data', chunk => {
    observe?.stderr?.(String(chunk))
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
