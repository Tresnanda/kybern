import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useGpuixRequired, type PublicInstance } from '@gpuix/react'
import { observeElementBounds } from '../native/layout.ts'
import { startupMark } from '../perf/startup.ts'
import { pixelWindowRange } from './windowRange.ts'
import { useHeldProjectRow } from './reorder.tsx'

const RowLease = createContext<(() => () => void) | null>(null)
/** Open overlays, inline editors and leaving rows retain their owner. */
export function useSidebarRowLease(active: boolean) {
  const acquire = useContext(RowLease)
  useLayoutEffect(() => active && acquire ? acquire() : undefined, [active, acquire])
}
export interface SidebarWindowEntry {
  key: string
  height: number | null
  pinned?: boolean
  render: (firstMount: boolean) => ReactNode
}

/** Stable logical slots preserve the native list's anchors and height cache;
 * only the nearby rich bodies mount. Geometry is observed, never polled. */
export function SidebarWindow({ entries, list, box, setList }: {
  entries: SidebarWindowEntry[]
  list: PublicInstance | null
  box: PublicInstance | null
  setList: (node: PublicInstance | null) => void
}) {
  const renderer = useGpuixRequired()
  const live = useRef({ entries, list, viewport: 820 })
  live.current.entries = entries; live.current.list = list
  const [viewport, setViewport] = useState(820)
  live.current.viewport = viewport
  const [anchor, setAnchor] = useState({ key: '', index: 0, offset: 0 })
  const range = useRef({ start: 0, end: 0 })
  const frameSeen = useRef(-1)
  const sync = useCallback((frame?: number) => {
    const { list, entries, viewport } = live.current
    if (!list || (frame !== undefined && frame <= frameSeen.current)) return
    if (frame !== undefined) frameSeen.current = frame
    const top = renderer.getListScrollTop?.(list.id)
    if (!top) return
    // Include the preceding row: List can normalize a partial boundary after paint.
    const index = Math.max(0, (top[0] ?? 0) - 1), offset = top[1] ?? 0
    const needed = pixelWindowRange(entries.length, i => entries[i]?.height ?? 30, index, offset, viewport, 640)
    if (needed.start >= range.current.start && needed.end <= range.current.end) return
    if (process.env.KYBERN_DEBUG_SIDEBAR === '1') console.error('[sidebar-window]', JSON.stringify({ top, needed, mounted: range.current, frame }))
    const key = entries[index]?.key ?? ''
    setAnchor(old => old.key === key && old.index === index && Math.abs(old.offset - offset) < 0.5 ? old : { key, index, offset })
  }, [renderer])
  useEffect(() => {
    if (!box) return
    return observeElementBounds(renderer, box.id, ({ rect }) => { if (rect) setViewport(rect.height) })
  }, [renderer, box])
  useEffect(() => { sync() }, [sync, list, entries.length])
  useEffect(() => {
    if (!list) return
    // A jump can paint only slots, so keep one observation on the list itself.
    return observeElementBounds(renderer, list.id, ({ frame }) => sync(frame))
  }, [renderer, list, sync])
  const at = entries.findIndex(entry => entry.key === anchor.key)
  range.current = pixelWindowRange(entries.length, i => entries[i]?.height ?? 30, at < 0 ? anchor.index : at, anchor.offset, viewport, Number(process.env.KYBERN_SIDEBAR_BUFFER ?? 768))
  if (process.env.KYBERN_DEBUG_SIDEBAR === '1') console.error('[sidebar-render]', JSON.stringify({ anchor, at, window: range.current, count: entries.length }))
  const window = range.current
  const traced = useRef(false)
  useLayoutEffect(() => {
    if (!traced.current && entries.length > 3) {
      traced.current = true
      startupMark('sidebar-bodies-committed', { slots: entries.length, bodies: window.end - window.start })
    }
  }, [entries, window.start, window.end])
  return <virtual-list {...(process.env.KYBERN_SIDEBAR_LAYOUT !== '0' ? { cacheLayout: true, cache: 'fill' as const } : {})}
    ref={setList} testId="thread-list" estimatedItemHeight={30} overdraw={Number(process.env.KYBERN_OVERDRAW ?? 128)}
    onVisibleRange={() => sync()}
    style={{ flexGrow: 1, minHeight: 0 }}>
    {entries.map((entry, index) => <SidebarSlot key={entry.key} rowKey={entry.key} height={entry.height}
      mounted={process.env.KYBERN_SIDEBAR_WINDOW === '0' || !!entry.pinned || entry.height === null || (index >= window.start && index < window.end)}
      sync={sync} render={entry.render} />)}
  </virtual-list>
}

const SidebarSlot = memo(function SidebarSlot({ rowKey, height, mounted, sync, render }: {
  rowKey: string; height: number | null; mounted: boolean
  sync: (frame?: number) => void; render: (firstMount: boolean) => ReactNode
}) {
  const renderer = useGpuixRequired()
  const node = useRef<PublicInstance | null>(null)
  const [leases, setLeases] = useState(0)
  const held = useHeldProjectRow(rowKey)
  const acquire = useCallback(() => {
    let active = true
    setLeases(n => n + 1)
    return () => { if (active) { active = false; setLeases(n => n - 1) } }
  }, [])
  const keep = mounted || held || leases > 0
  const lifetime = useRef({ mounted: false, count: 0 })
  if (keep && !lifetime.current.mounted) lifetime.current.count++
  lifetime.current.mounted = keep
  useEffect(() => {
    if (!node.current || !keep) return
    // Cached scrolling need not change the native visibleRange. Painted slot
    // bounds still advance; every observer shares this one logical-anchor read.
    return observeElementBounds(renderer, node.current.id, ({ frame }) => sync(frame))
  }, [renderer, keep, sync])
  return <div ref={node} testId={`sidebar-slot:${rowKey}`} style={{ width: '100%', flexShrink: 0, ...(!keep && height !== null ? { height } : {}) }}>
    {keep ? <RowLease.Provider value={acquire}>{render(lifetime.current.count === 1)}</RowLease.Provider> : null}
  </div>
})
