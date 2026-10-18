/**
 * Run one command under ONE preview UI lease from the fair queue (`/tmp/kybern-gpuix-ui-queue`, lock
 * `/tmp/kybern-gpuix-round5-ui-lock`). Joins the queue only now, waits until its line is first and the lock is free, takes
 * the lock, runs the command with `KYBERN_PACING_PARENT_LEASE` (and `KYBERN_CLIP_LOCK_HELD`) so lock-using checks inside
 * it reuse this lease instead of queueing behind it, then leaves the queue and releases the lock.
 *   bun native/ui-lease.ts <lane> <command> [args…]
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { acquirePreviewUiLock } from '../scripts/preview-ui-lock.ts'

const queue = '/tmp/kybern-gpuix-ui-queue', lock = '/tmp/kybern-gpuix-round5-ui-lock'
const [lane, ...command] = process.argv.slice(2)
if (!lane || !command.length) throw Error('usage: bun native/ui-lease.ts <lane> <command> [args…]')
const root = path.resolve(import.meta.dir, '../../..')
const env = { ...process.env, KYBERN_PACING_PARENT_LEASE: root, KYBERN_CLIP_LOCK_HELD: '1' }
let child: ReturnType<typeof Bun.spawn> | undefined
const run = async () => {
  child = Bun.spawn(command, { env, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' })
  const timeout = setTimeout(() => child?.kill(), 295000)
  try { return await child.exited } finally { clearTimeout(timeout) }
}

// Native checks never enter another lane's final measurement window.
while (readdirSync('/tmp').some(name => name.startsWith('kybern-gpuix-quiet.'))) await Bun.sleep(1000)

// Already inside a lease of this checkout (a caller holds it): just run.
if (process.env.KYBERN_PACING_PARENT_LEASE === root && existsSync(`${lock}/owner`) && readFileSync(`${lock}/owner`, 'utf8') === root) {
  process.exit(await run())
}

const lines = () => (existsSync(queue) ? readFileSync(queue, 'utf8').split('\n').filter(Boolean) : [])
// Queue changes are serialized through Python, including cleanup.
const edit = (join: boolean) => execFileSync('python3', ['-c', `import pathlib,sys,fcntl
p=pathlib.Path(sys.argv[1]);p.touch(exist_ok=True)
with p.open('r+') as f:
 fcntl.flock(f,fcntl.LOCK_EX)
 lines=[s for s in f.read().splitlines() if s];lane=sys.argv[2]
 if sys.argv[3]=='join' and lane not in lines:lines.append(lane)
 if sys.argv[3]=='leave':lines=[s for s in lines if s!=lane]
 f.seek(0);f.write(''.join(s+'\\n' for s in lines));f.truncate()
`, queue, lane, join ? 'join' : 'leave'])
const leave = () => { edit(false) }

let release: (() => void) | undefined
const quit = () => { child?.kill(); leave(); release?.(); if (!child) process.exit(130) }
process.on('SIGINT', quit)
process.on('SIGTERM', quit)

if (!lines().includes(lane)) edit(true)
const deadline = Date.now() + 60 * 60_000
while (!release) {
  if (Date.now() > deadline) { leave(); throw Error(`Timed out waiting for the UI lease (queue: ${lines().join(', ')})`) }
  if (!lines().includes(lane)) edit(true)
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
