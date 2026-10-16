import {appendFileSync} from 'node:fs'
import { connectStdio } from '@gpuix/react/automation'
import { spawn } from 'node:child_process'

/** Automation launch with an explicit process lifetime and startup deadline.
 * The upstream launch helper doesn't reject when a child exits before handshake. */
export async function launchFixture(entry: string, env: Record<string, string>) {
  const child = spawn('bun', [entry], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-8000); if(process.env.R7_LOG)appendFileSync(process.env.R7_LOG,chunk) })
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
    return { app, pid: child.pid!, diagnostics: () => stderr, close: async () => { await app.close(); if (child.exitCode === null) child.kill() } }
  } catch (error) { clearTimeout(timer); child.kill(); throw error }
}

