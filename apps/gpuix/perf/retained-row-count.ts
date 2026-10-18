/** Count React row mounts and retained host nodes, without GPUI/AppKit or a daemon.
 * This is a structural probe, NOT a scrolling/FPS/footprint benchmark.
 * Run: bun perf/retained-row-count.ts
 */
import { createElement, useEffect } from 'react'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
// The package has no public headless reconciler entry point. Use its installed
// reconciler directly; @gpuix/native/host is JS-only and never opens a window.
const entry = require.resolve('@gpuix/react')
const { createRoot, flushSync } = await import(pathToFileURL(path.join(path.dirname(entry), 'reconciler/reconciler.js')).href)

const results = []
for (const count of [300, 3000]) {
  for (const windowed of [false, true]) {
    let rendered = 0, mounted = 0, nextId = 0
    const hosts = new Map<number, string>()
    const renderer = {
      applyBatch(json: string) {
        for (const [op, id, value] of JSON.parse(json)) {
          if (op === 'createElement') { hosts.set(id, value); nextId = Math.max(nextId, id) }
          if (op === 'destroyElement') hosts.delete(id)
        }
        return []
      },
      setWindowKeyEvents() {}, setWindowSelectionChange() {},
    }
    function Row({ index }: { index: number }) {
      rendered++
      useEffect(() => { mounted++; return () => { mounted-- } }, [])
      return createElement('div', { style: { height: 28 } },
        createElement('text', { style: { color: '#fff' } }, `Row ${index}`),
        createElement('svg', { source: '<svg />' }))
    }
    const root = createRoot(renderer)
    // Fixed 600px viewport is intentionally irrelevant to React. Native List
    // receives every child unless the caller supplies a mount window.
    flushSync(() => root.render(createElement('virtual-list', {
      estimatedItemHeight: 28, overdraw: 0, style: { height: 600 },
      ...(windowed ? { itemCount: count, windowStart: 0 } : {}),
    }, Array.from({ length: windowed ? Math.min(32, count) : count }, (_, index) =>
      createElement(Row, { key: index, index })))))
    await new Promise(resolve => setTimeout(resolve, 0))
    results.push({ totalRows: count, providedRows: windowed ? Math.min(32, count) : count,
      mode: windowed ? 'caller mounts 32 rows' : 'all children supplied',
      reactRowRenders: rendered, mountedReactRows: mounted,
      retainedHostNodes: hosts.size, maxAllocatedId: nextId })
    root.unmount()
  }
}
console.log(JSON.stringify({ kind: 'headless structural counts; no native paint or FPS measured', results }, null, 2))
