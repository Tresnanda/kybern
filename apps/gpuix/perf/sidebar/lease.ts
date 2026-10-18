import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { acquirePreviewUiLock } from '../../scripts/preview-ui-lock.ts'
const root = path.resolve(import.meta.dir, '../../../..'), lane = 'perf-sidebar'
const queue = '/tmp/kybern-gpuix-ui-queue', lock = '/tmp/kybern-gpuix-round5-ui-lock'
const command = process.argv.slice(2).filter((arg, i) => i !== 0 || arg !== '--')
if (!command.length) throw Error('Pass a command')
// All queue edits use Python, as required by the shared performance brief.
function edit(action: string) {
  execFileSync('python3', ['-c', `import pathlib,sys,fcntl
p=pathlib.Path(sys.argv[1]); p.touch(exist_ok=True)
with p.open('r+') as f:
 fcntl.flock(f,fcntl.LOCK_EX)
 lines=f.read().splitlines(); lane=sys.argv[2]
 lines=[x for x in lines if x]
 if sys.argv[3]=='join' and lane not in lines: lines.append(lane)
 if sys.argv[3]=='leave': lines=[x for x in lines if x!=lane]
 f.seek(0); f.write(''.join(x+'\\n' for x in lines)); f.truncate()
`, queue, lane, action])
}
let release: (() => void) | undefined
let child: ReturnType<typeof Bun.spawn> | undefined
const cleanup = () => { edit('leave'); release?.(); release = undefined }
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { child?.kill(signal); cleanup(); if (!child) process.exit(130) })
const building = () => readdirSync('/tmp').some(name => name.startsWith('kybern-gpuix-native-build.'))
// Wait outside the shared UI queue while a native build is active.
while (building()) await Bun.sleep(1000)
edit('join')
try {
  while (!release) {
    if (building()) {
      edit('leave')
      while (building()) await Bun.sleep(1000)
      edit('join')
      continue
    }
    if (readFileSync(queue, 'utf8').split('\n').filter(Boolean)[0] === lane && !existsSync(lock)) {
      try { release = acquirePreviewUiLock() } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    }
    if (!release) await Bun.sleep(1000)
  }
  child = Bun.spawn(command, { env: { ...process.env, KYBERN_PACING_PARENT_LEASE: root }, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' })
  const timeout = setTimeout(() => child?.kill(), 295000)
  process.exitCode = await child.exited
  clearTimeout(timeout)
} finally { cleanup() }
