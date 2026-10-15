import { execFileSync } from 'node:child_process'
export function cpuSeconds(pid: number): number {
  const t = execFileSync('ps', ['-o', 'time=', '-p', String(pid)], { encoding: 'utf8' }).trim()
  const parts = t.split(':').map(Number)
  return parts.reduce((acc, v) => acc * 60 + v, 0)
}

export function gpuNs(): Map<number, number> {
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

export function footprintMiB(pid: number): number {
  const out = execFileSync('footprint', ['-p', String(pid)], { encoding: 'utf8' })
  const m = out.match(/Footprint:\s+([\d.]+)\s+([KMG]B)/)
  if (!m) return NaN
  const v = Number(m[1])
  return m[2] === 'GB' ? v * 1024 : m[2] === 'KB' ? v / 1024 : v
}

