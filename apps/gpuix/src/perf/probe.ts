// Perf probe (KYBERN_PERF_PROBE=1): after the app settles, print how many
// elements the retained tree holds per top-level region, how many were painted,
// and GPUI's frame draw times while whatever is animating keeps running.
import type { NativeRenderer } from '@gpuix/react'

type Node = { id?: number; type?: string; testId?: string; bounds?: { width: number; height: number } | null; children?: Node[] }

function walk(node: Node, fn: (n: Node, path: string[]) => void, path: string[] = []) {
  const here = node.testId ? [...path, node.testId] : path
  fn(node, here)
  for (const c of node.children ?? []) walk(c, fn, here)
}

const lines: string[] = []
function log(line: string) {
  lines.push(line)
  if (!process.env.KYBERN_PERF_PROBE_OUT) console.log(line)
}

export function startPerfProbe(renderer: NativeRenderer) {
  if (process.env.KYBERN_PERF_PROBE !== '1') return
  const r = renderer as NativeRenderer & {
    getAutomationTree?: () => string
    getDebugFrameOverlayStats?: () => { p90Ms?: number; p99Ms?: number; maxMs?: number; frames: number; samples: number; currentMs?: number }
    resetDebugFrameOverlayStats?: () => void
  }
  setTimeout(() => {
    const tree = JSON.parse(r.getAutomationTree?.() ?? '{}') as Node | Node[]
    const roots = Array.isArray(tree) ? tree : [tree]
    const byRegion = new Map<string, { all: number; painted: number }>()
    const byType = new Map<string, number>()
    let all = 0
    let painted = 0
    for (const root of roots)
      walk(root, (n, path) => {
        all++
        const wasPainted = !!n.bounds
        if (wasPainted) painted++
        const region = path.slice(0, 2).join(' > ') || '(root)'
        const e = byRegion.get(region) ?? { all: 0, painted: 0 }
        e.all++
        if (wasPainted) e.painted++
        byRegion.set(region, e)
        byType.set(n.type ?? '?', (byType.get(n.type ?? '?') ?? 0) + 1)
      })
    log(`[probe] elements retained=${all} painted=${painted}`)
    log('[probe] by type ' + JSON.stringify(Object.fromEntries([...byType].sort((a, b) => b[1] - a[1]))))
    for (const [k, v] of [...byRegion].sort((a, b) => b[1].all - a[1].all).slice(0, 25)) log(`[probe] ${String(v.all).padStart(6)} ${String(v.painted).padStart(6)}  ${k}`)
    r.resetDebugFrameOverlayStats?.()
    setTimeout(() => {
      log('[probe] frames ' + JSON.stringify(r.getDebugFrameOverlayStats?.()))
      if (process.env.KYBERN_PERF_PROBE_OUT) require('node:fs').writeFileSync(process.env.KYBERN_PERF_PROBE_OUT, lines.join('\n') + '\n')
      if (!process.env.KYBERN_PERF_PROBE_STAY) process.exit(0)
    }, 5000)
  }, Number(process.env.KYBERN_PERF_PROBE_DELAY ?? 8000))
}
