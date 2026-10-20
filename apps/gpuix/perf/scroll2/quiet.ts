/** One queued build-free window, released on every exit path. */
import { execFileSync } from 'node:child_process'
import { existsSync, openSync, closeSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
const lane = 'perf-scroll2', order = '/tmp/kybern-gpuix-quiet-order', quiet = `/tmp/kybern-gpuix-quiet.${lane}`
const names = (prefix: string) => readdirSync('/tmp').filter(name => name.startsWith(prefix))
function edit(action: string) {
  execFileSync('python3', ['-c', `import pathlib,sys,fcntl
p=pathlib.Path(sys.argv[1]);p.touch(exist_ok=True)
with p.open('r+') as f:
 fcntl.flock(f,fcntl.LOCK_EX)
 lines=[s for s in f.read().splitlines() if s];lane=sys.argv[2]
 if sys.argv[3]=='join' and lane not in lines: lines.append(lane)
 if sys.argv[3]=='leave': lines=[s for s in lines if s!=lane]
 f.seek(0);f.write(''.join(s+'\\n' for s in lines));f.truncate()
`, order, lane, action])
}
let owned = false, child: ReturnType<typeof Bun.spawn> | undefined, stopped = false
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { stopped = true; child?.kill(signal) })
edit('join')
try {
  while (!stopped && !owned) {
    const first = readFileSync(order, 'utf8').split('\n').filter(Boolean)[0]
    const reserved = names('kybern-gpuix-quiet-next.').filter(name => name !== `kybern-gpuix-quiet-next.${lane}`)
    if (first === lane && !reserved.length && !names('kybern-gpuix-quiet.').length && !names('kybern-gpuix-native-build.').length && !names('kybern-gpuix-build-next.').length) {
      try {
        closeSync(openSync(quiet, 'wx')); owned = true
        writeFileSync(quiet, `${lane} ${new Date().toISOString()} final paired sidebar metrics; expected end ${new Date(Date.now() + 24 * 60 * 1000).toISOString()}\n`)
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    }
    if (!owned) await Bun.sleep(1000)
  }
  if (!stopped) {
    child = Bun.spawn(process.argv.slice(2), { env: { ...process.env, SCROLL2_TIMING: '1' }, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' })
    const timeout = setTimeout(() => child?.kill(), 24 * 60 * 1000)
    process.exitCode = await child.exited
    clearTimeout(timeout)
  }
} finally {
  if (owned && existsSync(quiet)) unlinkSync(quiet)
  edit('leave')
}
