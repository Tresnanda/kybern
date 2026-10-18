/**
 * Run one command under ONE preview UI lease from the fair queue (`/tmp/kybern-gpuix-ui-queue`, lock
 * `/tmp/kybern-gpuix-round5-ui-lock`). Joins the queue only now, waits until its line is first and the lock is free, takes
 * the lock, runs the command with `KYBERN_PACING_PARENT_LEASE` (and `KYBERN_CLIP_LOCK_HELD`) so lock-using checks inside
 * it reuse this lease instead of queueing behind it, then leaves the queue and releases the lock.
 *   bun native/ui-lease.ts <lane> <command> [args…]
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { acquirePreviewUiLock } from '../scripts/preview-ui-lock.ts'

const queue = '/tmp/kybern-gpuix-ui-queue', lock = '/tmp/kybern-gpuix-round5-ui-lock'
const [lane, ...command] = process.argv.slice(2)
if (!lane || !command.length) throw Error('usage: bun native/ui-lease.ts <lane> <command> [args…]')
const root = path.resolve(import.meta.dir, '../../..')
const env = { ...process.env, KYBERN_PACING_PARENT_LEASE: root, KYBERN_CLIP_LOCK_HELD: '1' }
let active: ChildProcess | undefined
let interrupted = false
let ownsGroup = true
let forcedStop: ReturnType<typeof setTimeout> | undefined
const signalGroup = (signal: NodeJS.Signals) => {
  if (!active?.pid) return
  try { if (ownsGroup) process.kill(-active.pid, signal); else active.kill(signal) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}
const run = async (detached = true) => {
  ownsGroup = detached
  // A separate process group owns only this command and its descendants. Stop
  // the group on interruption and after exit, including any orphaned fixtures.
  active = spawn(command[0]!, command.slice(1), { env, stdio: 'inherit', detached })
  try {
    return await new Promise<number>((resolve, reject) => {
      active!.once('error', reject)
      active!.once('exit', code => resolve(interrupted ? 130 : code ?? 1))
    })
  } finally {
    signalGroup('SIGKILL')
    if (forcedStop) clearTimeout(forcedStop)
    active = undefined
  }
}

const lines = () => (existsSync(queue) ? readFileSync(queue, 'utf8').split('\n').filter(Boolean) : [])
const leave = () => {
  const rest = lines().filter(line => line !== lane)
  writeFileSync(queue, rest.join('\n') + (rest.length ? '\n' : ''))
}
let release: (() => void) | undefined
const quit = () => {
  if (interrupted) return
  interrupted = true
  if (!active) { leave(); release?.(); process.exit(130) }
  signalGroup('SIGTERM')
  forcedStop = setTimeout(() => signalGroup('SIGKILL'), 1000)
}
process.on('SIGINT', quit)
process.on('SIGTERM', quit)

// Already inside a lease of this checkout (a caller holds it): just run.
if (process.env.KYBERN_PACING_PARENT_LEASE === root && existsSync(`${lock}/owner`) && readFileSync(`${lock}/owner`, 'utf8') === root) {
  process.exit(await run(false))
}

if (!lines().includes(lane)) appendFileSync(queue, `${lane}\n`)
const deadline = Date.now() + 60 * 60_000
while (!release) {
  if (Date.now() > deadline) { leave(); throw Error(`Timed out waiting for the UI lease (queue: ${lines().join(', ')})`) }
  if (!lines().includes(lane)) appendFileSync(queue, `${lane}\n`)
  if (lines()[0] !== lane || existsSync(lock)) { await Bun.sleep(2000); continue }
  try {
    release = acquirePreviewUiLock()
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') { leave(); throw e }
    await Bun.sleep(2000)
  }
}
let code = 1
try {
  console.log(`[ui-lease] ${lane} holds the UI lease`)
  code = await run()
} finally {
  // Hand the queue on while still holding the lock, then release it.
  leave()
  release?.()
  console.log(`[ui-lease] ${lane} released the UI lease`)
}
process.exit(code)
