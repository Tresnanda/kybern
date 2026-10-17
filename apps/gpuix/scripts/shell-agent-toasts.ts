/**
 * Agent event toasts against the SCRATCH daemon (writes: new threads, one deny).
 * Starts two haiku turns from the CLI while the app shows its home screen:
 * a finished turn, then one that waits for approval. Samples idle CPU while the
 * approval toast (which stays) is on screen, then denies it and checks it goes.
 *
 *   KYBERN_DATA_DIR=<scratch> bun scripts/shell-agent-toasts.ts <out-dir> <kybern-cli>
 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { launch } from '@gpuix/react/automation'

const out = process.argv[2]!
const cli = process.argv[3]!
const data = process.env.KYBERN_DATA_DIR!
mkdirSync(out, { recursive: true })
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const k = (...args: string[]) => execFileSync(cli, ['--data-dir', data, ...args], { encoding: 'utf8' })
const project = k('projects', 'list').split(/\s+/)[0]!

const main = path.join(import.meta.dir, '../src/main.tsx')
const app = await launch({ command: 'bun', args: [main], env: { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: 'dark', KYBERN_DATA_DIR: data } })
await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
await wait(2500)
const pid = Number(execFileSync('pgrep', ['-f', main], { encoding: 'utf8' }).trim().split('\n')[0])
const toasts = () => app.getByTestId('toast-default').count()
const until = async (what: string, ok: () => Promise<boolean>, ms = 90_000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await ok()) return true
    await wait(500)
  }
  console.log(`[agent-toasts] timed out: ${what}`)
  return false
}

if (!process.env.SKIP_DONE) {
console.log('[agent-toasts] turn 1: finishes')
k('new', '-p', project, '--model', 'claude-haiku-5-5', '--detach', 'Reply with exactly: ok')
if (await until('finished toast', async () => (await toasts()) > 0)) {
  await wait(700)
  await app.screenshot({ path: path.join(out, 'agent-finished.png') })
  console.log('[agent-toasts] finished toast text:', await app.getByTestId('toast-default').textContent())
}
// It leaves on its own after 6 s.
console.log('[agent-toasts] finished toast gone after timeout:', await until('toast timeout', async () => (await toasts()) === 0, 15_000))
}

console.log('[agent-toasts] turn 2: needs approval')
k('new', '-p', project, '--model', 'claude-haiku-5-5', '--detach', 'Create a file named approval-probe.txt containing the word hi, using the Write tool, then stop.')
if (await until('approval toast', async () => (await toasts()) > 0)) {
  await wait(700)
  await app.screenshot({ path: path.join(out, 'agent-approval.png') })
  console.log('[agent-toasts] approval toast text:', await app.getByTestId('toast-default').textContent())
  await wait(9000)
  console.log('[agent-toasts] approval toast still there after 9 s:', (await toasts()) > 0)
  const sampleOut = await new Promise<string>((resolve) => {
    const child = spawn('bun', [path.join(import.meta.dir, '../perf/sample.ts'), '12', `GPUIX=${pid}`], { stdio: ['ignore', 'pipe', 'inherit'] })
    let text = ''
    child.stdout.on('data', (d) => (text += d))
    child.on('close', () => resolve(text.trim().split('\n').slice(-3).join(' | ')))
  })
  console.log('[agent-toasts] idle with approval toast', sampleOut)
  const listed = k('approvals', 'list')
  const id = listed.split(/\s+/)[0]!
  if (listed.includes('no pending')) console.log('[agent-toasts] no approval was pending (the agent did not ask)')
  console.log('[agent-toasts] denying', id)
  if (!listed.includes('no pending')) k('approvals', 'deny', id)
  console.log('[agent-toasts] approval toast dismissed when answered:', await until('dismissed', async () => (await toasts()) === 0, 20_000))
}
await app.close()
