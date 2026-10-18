// Resume only unfinished controls after a bounded quiet window expires. Completed
// results remain untouched; rejected attempts stay in their evidence directories.
import {existsSync, readFileSync} from 'node:fs'
import {onExit} from '../bench/lifetime.ts'
const winner = 'documents'
const complete = (label: string, count: number) => {
  const file = `${import.meta.dir}/../bench/results/${label}.json`
  return existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).results.filter((r: {status: string}) => r.status === 'ok').length === count
}
async function run(args: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn(['bun', ...args], {env: {...process.env, ...env}, stdout: 'inherit', stderr: 'inherit'})
  const stop = onExit(async () => { child.kill('SIGTERM'); await child.exited })
  const code = await child.exited
  stop()
  if (code) throw Error(`Resumed control failed (${code})`)
}
for (const wheel of [true, false]) {
  const missing = ['before', winner].filter(name => !complete(`final-${name}-${wheel ? 'wheel' : 'stream'}`, wheel ? 3 : 1))
  if (missing.length) await run(['perf/stream/pair.ts', ...missing, '--final', ...(wheel ? ['--wheel'] : [])])
}
for (const variant of ['before', winner]) {
  if (complete(`final-${variant}-idle`, 1)) continue
  await run(['perf/bench/run.ts', 'idle-thread', '--runs', '1', '--label', `final-${variant}-idle`, '--keep-data'], {
    KYBERN_DATA_DIR: '/Users/mymac/projects/ade-gpuix-scratch/perf-stream', KYBERN_BENCH_PORT: '4330',
    KYBERN_BENCH_EVIDENCE: '/Users/mymac/projects/ade/previews/gpuix/perf/stream', KYBERN_FULL_RATE: '1',
    KYBERN_STREAM_ISOLATE: variant === 'before' ? '0' : '1', KYBERN_STREAM_EVENT_FRAME: variant === 'before' ? '0' : '1', KYBERN_STREAM_DOCUMENT: variant === 'before' ? '0' : '1',
  })
}
