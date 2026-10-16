/**
 * Sample physical footprint, CPU time and GPU time for groups of processes over
 * one window, so two apps can be compared under the same conditions.
 *
 *   bun perf/sample.ts <seconds> name=pid,pid,... [name=pid,...]
 *
 * Footprint: `footprint -p` (phys_footprint, what Activity Monitor calls Memory).
 * CPU: cumulative `ps -o time` delta. GPU: the Metal driver's per-client
 * `accumulatedGPUTime` from `ioreg` (AGXDeviceUserClient), summed per pid.
 */
import { execFileSync } from 'node:child_process'

const seconds = Number(process.argv[2] ?? 30)
const groups = process.argv.slice(3).map((arg) => {
  const [name, list] = arg.split('=')
  return { name, pids: list.split(',').map(Number) }
})

function cpuSeconds(pid: number): number {
  const t = execFileSync('ps', ['-o', 'time=', '-p', String(pid)], { encoding: 'utf8' }).trim()
  const parts = t.split(':').map(Number)
  return parts.reduce((acc, v) => acc * 60 + v, 0)
}

function gpuNs(): Map<number, number> {
  const out = execFileSync('ioreg', ['-r', '-c', 'AGXDeviceUserClient', '-l'], { encoding: 'utf8', maxBuffer: 64 << 20 })
  const map = new Map<number, number>()
  let usage = 0
  for (const line of out.split('\n')) {
    const u = line.match(/"AppUsage" = \((.*)\)/)
    if (u) usage = [...u[1].matchAll(/"accumulatedGPUTime"=(\d+)/g)].reduce((a, m) => a + Number(m[1]), 0)
    const c = line.match(/"IOUserClientCreator" = "pid (\d+),/)
    if (c) {
      const pid = Number(c[1])
      map.set(pid, (map.get(pid) ?? 0) + usage)
      usage = 0
    }
  }
  return map
}

function footprintMiB(pid: number): number {
  const out = execFileSync('footprint', ['-p', String(pid)], { encoding: 'utf8' })
  const m = out.match(/Footprint:\s+([\d.]+)\s+([KMG]B)/)
  if (!m) return NaN
  const v = Number(m[1])
  return m[2] === 'GB' ? v * 1024 : m[2] === 'KB' ? v / 1024 : v
}

// Capture CPU endpoints before slow footprint queries. Time each process's
// actual interval, including collection overhead, rather than the requested sleep.
function cpuSnapshot(pid: number) {
  const start = performance.now()
  const value = cpuSeconds(pid)
  return { value, at: (start + performance.now()) / 2 }
}
const cpu0 = groups.map((g) => g.pids.map(cpuSnapshot))
const gpu0 = gpuNs()
const gpuStart = performance.now()
await new Promise((r) => setTimeout(r, seconds * 1000))
const gpu1 = gpuNs()
const gpuElapsed = (performance.now() - gpuStart) / 1000
const cpu1 = groups.map((g) => g.pids.map(cpuSnapshot))
for (const [gi, g] of groups.entries()) {
  console.log(`\n${g.name}`)
  let tf = 0, tc = 0, tg = 0
  for (const [i, pid] of g.pids.entries()) {
    const comm = execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' }).trim().split('/').pop()
    const fp = footprintMiB(pid)
    const before = cpu0[gi][i]
    const after = cpu1[gi][i]
    const cpu = (after.value - before.value) / ((after.at - before.at) / 1000) * 100
    const gpu = ((gpu1.get(pid) ?? 0) - (gpu0.get(pid) ?? 0)) / 1e6
    tf += fp; tc += cpu; tg += gpu
    console.log(`  ${String(pid).padEnd(6)} ${comm!.slice(0, 34).padEnd(34)} ${fp.toFixed(1).padStart(8)} MiB  cpu ${cpu.toFixed(2).padStart(6)}%  gpu ${(tg >= 0 ? gpu : 0).toFixed(1).padStart(7)} ms`)
  }
  console.log(`  ${'total'.padEnd(41)} ${tf.toFixed(1).padStart(8)} MiB  cpu ${tc.toFixed(2).padStart(6)}%  gpu ${tg.toFixed(1).padStart(7)} ms over ${gpuElapsed.toFixed(2)}s`)
}
