/**
 * Connection chrome against a throwaway daemon (never the scratch or real one):
 * banner while the daemon is gone, recovery, and Reconnect after a failed start.
 *
 *   bun scripts/shell-conn.ts <out-dir> <daemon-binary> [--light]
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launch } from '@gpuix/react/automation'

const out = process.argv[2]!
const daemonBin = process.argv[3]!
const light = process.argv.includes('--light')
const sfx = light ? '-light' : ''
const data = path.join(tmpdir(), `kybern-shell-conn-${process.pid}`)
const PORT = 4377
mkdirSync(out, { recursive: true })
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

let daemon: ChildProcess | null = null
async function startDaemon() {
  daemon = spawn(daemonBin, ['--data-dir', data, '--port', String(PORT)], { stdio: 'ignore' })
  for (let i = 0; i < 100 && !existsSync(path.join(data, 'daemon.token')); i++) await wait(100)
  await wait(500)
}
const stopDaemon = async () => {
  daemon?.kill('SIGTERM')
  daemon = null
  await wait(800)
}

async function run(name: string, body: (app: Awaited<ReturnType<typeof launch>>, shot: (n: string) => Promise<string>) => Promise<void>) {
  const app = await launch({
    command: 'bun',
    args: [path.join(import.meta.dir, '../src/main.tsx')],
    env: { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: light ? 'light' : 'dark', KYBERN_DATA_DIR: data },
  })
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
  try {
    await body(app, (n) => app.screenshot({ path: path.join(out, `conn-${name}-${n}${sfx}.png`) }))
  } finally {
    await app.close()
  }
}

try {
  // 1. Connected, then the daemon goes away and comes back.
  await startDaemon()
  await run('drop', async (app, shot) => {
    await wait(2500)
    await shot('open')
    console.log('banner while open:', await app.getByTestId('connection-banner').count())
    await stopDaemon()
    await wait(2500)
    await shot('reconnecting')
    console.log('banner after daemon stop:', await app.getByTestId('connection-banner').count())
    await startDaemon()
    await wait(9000)
    await shot('recovered')
    console.log('banner after daemon start:', await app.getByTestId('connection-banner').count())
  })
  await stopDaemon()
  rmSync(data, { recursive: true, force: true })

  // 2. No daemon at launch: Welcome (unavailable) and a failed banner with Reconnect.
  await run('cold', async (app, shot) => {
    await wait(2000)
    await shot('unavailable')
    console.log('banner cold:', await app.getByTestId('connection-banner').count(), 'welcome:', await app.getByTestId('welcome').count())
    await startDaemon()
    await app.getByTestId('connection-reconnect').click()
    await wait(4000)
    await shot('after-reconnect')
    console.log('banner after Reconnect:', await app.getByTestId('connection-banner').count(), 'welcome:', await app.getByTestId('welcome').count())
  })
} finally {
  await stopDaemon()
  rmSync(data, { recursive: true, force: true })
}
