import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useGpuixRequired, type PublicInstance } from '@gpuix/react'
import { observeElementBounds } from '../native/layout.ts'
import { startupMark } from '../perf/startup.ts'
import { SparseRetention, sparseIndices, useSparseList } from '../kit/sparseList.tsx'
import { pixelWindowRange } from './windowRange.ts'
import { useHeldProjectRow } from './reorder.tsx'
import { onSpaceSwitched } from '../spaces/current.ts'

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

/** Sparse hosts share stable logical metadata with the native height summary.
 * Geometry is observed, never polled; leased owners stay mounted offscreen. */
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
  // A space switch starts its list from the top.
  useEffect(() => onSpaceSwitched(() => { const node = live.current.list; if (node) renderer.scrollToItem?.(node.id, 0) }), [renderer])
  useEffect(() => {
    if (!list) return
    // A jump can paint only slots, so keep one observation on the list itself.
    return observeElementBounds(renderer, list.id, ({ frame }) => sync(frame))
  }, [renderer, list, sync])
  const keys = useMemo(() => entries.map(entry => entry.key), [entries])
  const estimates = useMemo(() => entries.map(entry => entry.height ?? 30), [entries])
  const sparse = process.env.KYBERN_SPARSE_LIST !== '0' && process.env.KYBERN_GPUIX_NATIVE !== 'npm' && process.env.KYBERN_SIDEBAR_WINDOW !== '0'
  const nativeWindow = useSparseList(keys, estimates, 'sidebar')
  const at = nativeWindow.indices.get(anchor.key) ?? -1
  range.current = pixelWindowRange(entries.length, i => entries[i]?.height ?? 30, at < 0 ? anchor.index : at, anchor.offset, viewport, Number(process.env.KYBERN_SIDEBAR_BUFFER ?? 768))
  if (process.env.KYBERN_DEBUG_SIDEBAR === '1') console.error('[sidebar-render]', JSON.stringify({ anchor, at, window: range.current, count: entries.length }))
  const window = range.current
  const pinned = useMemo(() => entries.flatMap((entry, index) => entry.pinned || entry.height === null ? [index] : []), [entries])
  // The permanent list observer includes native anchor changes; fixed-height
  // rows do not need a separate position event on every scroll frame.
  const observeRows = !sparse || process.env.KYBERN_SIDEBAR_LAYOUT === '0' || process.env.KYBERN_SIDEBAR_ROW_OBSERVERS === '1'
  const indices = sparse ? sparseIndices(window.start, window.end, entries.length, [...pinned, ...[...nativeWindow.retained].flatMap(key => { const index = nativeWindow.indices.get(key); return index === undefined ? [] : [index] })]) : entries.map((_,i) => i)
  const traced = useRef(false)
  useLayoutEffect(() => {
    if (!traced.current && entries.length > 3) {
      traced.current = true
      startupMark('sidebar-bodies-committed', { slots: entries.length, retainedSlots: indices.length, bodies: window.end - window.start })
    }
  }, [entries, window.start, window.end])
  return <SparseRetention.Provider value={nativeWindow.context}><virtual-list {...(process.env.KYBERN_SIDEBAR_LAYOUT !== '0' ? { cacheLayout: true, cache: 'fill' as const } : {})}
    {...(sparse ? { estimatedItemHeight: 30, itemCount: entries.length, windowStart: indices[0] ?? 0, windowIndices: indices, ...nativeWindow.props } : { estimatedItemHeight: 30 })}
    ref={setList} testId="thread-list" overdraw={Number(process.env.KYBERN_OVERDRAW ?? 128)}
    onVisibleRange={() => sync()}
    style={{ flexGrow: 1, minHeight: 0 }}>
    {indices.map(index => { const entry = entries[index]!; return <SidebarSlot key={entry.key} rowKey={entry.key} height={entry.height}
      mounted={sparse || process.env.KYBERN_SIDEBAR_WINDOW === '0' || !!entry.pinned || entry.height === null || (index >= window.start && index < window.end)}
      sync={sync} observe={observeRows} render={entry.render} /> })}
  </virtual-list></SparseRetention.Provider>
}

const SidebarSlot = memo(function SidebarSlot({ rowKey, height, mounted, sync, observe, render }: {
  rowKey: string; height: number | null; mounted: boolean
  sync: (frame?: number) => void; observe: boolean; render: (firstMount: boolean) => ReactNode
}) {
  const renderer = useGpuixRequired()
  const retention = useContext(SparseRetention)
  const node = useRef<PublicInstance | null>(null)
  const [leases, setLeases] = useState(0)
  const held = useHeldProjectRow(rowKey)
  const acquire = useCallback(() => {
    let active = true
    setLeases(n => n + 1)
    return () => { if (active) { active = false; setLeases(n => n - 1) } }
  }, [])
  const keep = mounted || held || leases > 0
  useLayoutEffect(() => { retention?.retain(rowKey, held || leases > 0); return () => retention?.retain(rowKey, false) }, [retention, rowKey, held, leases])
  const lifetime = useRef({ mounted: false, count: retention?.visited.has(rowKey) ? 1 : 0 })
  if (keep && !lifetime.current.mounted) { lifetime.current.count++; retention?.visited.add(rowKey) }
  lifetime.current.mounted = keep
  useEffect(() => {
    if (!observe || !node.current || !keep) return
    // Cached scrolling need not change the native visibleRange. Painted slot
    // bounds still advance; every observer shares this one logical-anchor read.
    return observeElementBounds(renderer, node.current.id, ({ frame }) => sync(frame))
  }, [renderer, keep, sync, observe])
  return <div ref={node} testId={`sidebar-slot:${rowKey}`} style={{ width: '100%', flexShrink: 0, ...(!keep && height !== null ? { height } : {}) }}>
    {keep ? <RowLease.Provider value={acquire}>{render(lifetime.current.count === 1)}</RowLease.Provider> : null}
  </div>
})
