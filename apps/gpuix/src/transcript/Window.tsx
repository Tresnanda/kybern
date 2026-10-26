import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useGpuixRequired, type PublicInstance } from '@gpuix/react'
import { observeElementBounds } from '../native/layout.ts'
import { SparseRetention } from '../kit/sparseList.tsx'
import { transcriptWindowRange, transcriptWindowRangeBy } from './windowRange.ts'

/** Off macOS, take the list anchor from the observation (WP1: no UI-thread round trip per scrolled frame). */
const OBSERVED_ANCHOR = process.platform !== 'darwin'

/** Whether the reader is at the tail, as a ref the transcript keeps current (reading it never re-renders a row). */
export const TranscriptTail = createContext<{ current: boolean }>({ current: false })
const FirstBodyMount = createContext(true)
export const useTranscriptFirstMount = () => useContext(FirstBodyMount)
const RowLease = createContext<(() => () => void) | null>(null)
export const TranscriptFocusRestoration = createContext<((elementId: number) => void) | null>(null)
export const useTranscriptFocusRestoration = () => useContext(TranscriptFocusRestoration)
/** An open row-owned overlay must survive scrolling its trigger out of view. */
export function useTranscriptRowLease(active: boolean) {
  const acquire = useContext(RowLease)
  useEffect(() => active && acquire ? acquire() : undefined, [active, acquire])
}
/** One parked timeout for fresh entrances, never a recurring animation clock. */
export function useTranscriptEntranceLease(milliseconds: number) {
  const acquire = useContext(RowLease)
  useEffect(() => {
    if (!milliseconds || !acquire) return
    const release = acquire(), timer = setTimeout(release, milliseconds)
    return () => { clearTimeout(timer); release() }
  }, [acquire, milliseconds])
}

/** Mount ownership is separate from GPUI List's stable logical slots/heights.
 * No clock or polling: native paint/scroll observations advance the window. */
export function useTranscriptWindow(keys: readonly string[], list: React.RefObject<PublicInstance | null>, viewport: number, identity: string | null, width = 0, estimates: readonly number[] = [], onReadPosition?: (index: number) => void) {
  const renderer = useGpuixRequired()
  const buffered = process.env.KYBERN_TRANSCRIPT_WINDOW_BUFFER !== '0'
  const [, refreshMeasurements] = useState(0)
  const measureTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(measureTimer.current), [])
  const heights = useRef(new Map<string, number>())
  const selected = useRef(new Set<string>())
  const [anchor, setAnchor] = useState({ key: '', index: 0, offset: 0 })
  const anchorRef = useRef(anchor)
  anchorRef.current = anchor
  const previousWidth = useRef(width)
  if(previousWidth.current !== width) { previousWidth.current = width; heights.current.clear() }
  const live = useRef({ keys, viewport, identity, estimates, onReadPosition })
  live.current = { keys, viewport, identity, estimates, onReadPosition }
  const previousIdentity = useRef(identity)
  const observedAnchor = useRef<readonly number[] | null>(null)
  if (previousIdentity.current !== identity) {
    previousIdentity.current = identity
    observedAnchor.current = null
    heights.current.clear()
    selected.current.clear()
  }
  const lastFrame = useRef(-1)
  const [rangeHint, setRangeHint] = useState<{start:number;end:number} | null>(null)
  const rangeRef = useRef({start:0,end:0})
  const sync = useCallback((frame?: number, observed?: readonly number[] | null) => {
    if (!list.current || (frame !== undefined && lastFrame.current === frame)) return
    if (frame !== undefined) lastFrame.current = frame
    // Off macOS getListScrollTop waits on GPUI's UI thread. The list's observations carry the anchor they painted;
    // row observations and range changes reuse the latest one (at most a frame old: the list re-syncs below).
    const scroll = (OBSERVED_ANCHOR && (observed ?? observedAnchor.current)) || renderer.getListScrollTop?.(list.current.id)
    if (!scroll) return
    const index = Math.max(0, (scroll[0] ?? 0) - 1), key = live.current.keys[index] ?? '', offset = scroll[1] ?? 0
    // The native range callback may stay unchanged across programmatic jumps
    // and reused geometry. Derive the rail's reading position from the actual
    // logical anchor, sharing this frame-coalesced observation with windowing.
    const {keys,estimates,viewport,onReadPosition} = live.current
    let middle = Math.max(0,Math.min(keys.length - 1,index))
    let remaining = (viewport || 820) / 2 + Math.abs(offset)
    if(index > 0) while(middle < keys.length - 1) {
      const height = Math.max(1,heights.current.get(keys[middle]!) ?? estimates[middle] ?? 160)
      if(remaining < height) break
      remaining -= height; middle++
    }
    onReadPosition?.(middle)
    // Retain selection owners until native selection clears. Subsequent windows
    // join that lease during cross-turn dragging; idle adds no timer.
    if (renderer.getSelectedText?.()) {
      for(let i=rangeRef.current.start;i<rangeRef.current.end;i++) if(live.current.keys[i]) selected.current.add(live.current.keys[i]!)
    } else {
      const hadSelection = selected.current.size > 0
      selected.current.clear()
      if(buffered && hadSelection) refreshMeasurements(n => n + 1)
    }
    if(buffered) {
      const {keys,estimates,viewport} = live.current
      const required = transcriptWindowRangeBy(keys.length, i => heights.current.get(keys[i]!) ?? estimates[i] ?? 160, index, offset, viewport || 820, 768)
      if(required.start >= rangeRef.current.start && required.end <= rangeRef.current.end) return
      setRangeHint(null)
      setAnchor({key,index,offset})
      return
    }
    setAnchor(old => old.key === key && old.index === index && Math.abs(old.offset-offset) < 128 ? old : { key, index, offset })
  }, [renderer, list, buffered])
  // Initial follow-tail/restore can paint only placeholder rows. Count changes
  // instead wait for the list's post-paint observation below: in a deferred
  // frame its numeric native offset still belongs to the previous key array.
  // The semantic anchor already keeps those visible bodies mounted meanwhile.
  useEffect(() => { sync() }, [sync, identity, width])
  // A permanent list observation also advances the window after a jump whose
  // previous rich bodies are all offscreen. Native emits only changed anchors.
  useEffect(() => {
    if (!list.current) return
    return observeElementBounds(renderer, list.current.id, ({frame, scrollTop}) => {
      if (OBSERVED_ANCHOR && scrollTop) {
        const changed = observedAnchor.current?.[0] !== scrollTop[0] || observedAnchor.current?.[1] !== scrollTop[1]
        observedAnchor.current = scrollTop
        // A row observation of this frame already synced with the previous anchor.
        if (changed && lastFrame.current === frame) { sync(undefined, scrollTop); return }
      }
      sync(frame, scrollTop)
    })
  }, [renderer, list, sync, identity, keys.length])
  const measure = useCallback((key: string, height: number) => {
    if (height < 0 || !Number.isFinite(height) || Math.abs((heights.current.get(key) ?? -1) - height) < 0.5) return
    heights.current.set(key, height)
    // Shrinking/empty rows can expose placeholders without changing the top
    // anchor. Refill once after the native measurement batch, only if needed;
    // do not turn a disclosure tween into a React animation clock.
    if(measureTimer.current) return
    measureTimer.current = setTimeout(() => {
      measureTimer.current = undefined
      if(buffered) { sync(); return }
      const {keys,viewport,estimates} = live.current, anchor = anchorRef.current
      const at = keys.indexOf(anchor.key)
      const next = transcriptWindowRange(keys.map((key,index) => heights.current.get(key) ?? estimates[index] ?? 160), at < 0 ? anchor.index : at, anchor.offset, viewport || 820)
      if(next.start < rangeRef.current.start || next.end > rangeRef.current.end) refreshMeasurements(n => n + 1)
    }, 0)
  }, [buffered, sync])
  const onRange = useCallback((start: number, end: number) => {
    sync()
    if(buffered && start >= rangeRef.current.start && end <= rangeRef.current.end) return
    setRangeHint(old => old?.start === start && old.end === end ? old : { start, end })
  }, [sync, buffered])
  useEffect(() => {
    const valid = new Set(keys)
    for(const key of heights.current.keys()) if(!valid.has(key)) heights.current.delete(key)
    for(const key of selected.current) if(!valid.has(key)) selected.current.delete(key)
  }, [keys])
  const keyIndices = useMemo(() => new Map(keys.map((key,index) => [key,index])), [keys])
  const at = keyIndices.get(anchor.key) ?? -1
  const range = buffered
    ? transcriptWindowRangeBy(keys.length, i => heights.current.get(keys[i]!) ?? estimates[i] ?? 160, at < 0 ? anchor.index : at, anchor.offset, viewport || 820)
    : transcriptWindowRange(keys.map((key,index) => heights.current.get(key) ?? estimates[index] ?? 160), at < 0 ? anchor.index : at, anchor.offset, viewport || 820)
  // The native callback can cover more rows than estimates while zero-height
  // slots normalize. Keep every reported row until the next native range.
  if (rangeHint && rangeHint.start <= range.end && rangeHint.end >= range.start) {
    range.start = Math.min(range.start, rangeHint.start)
    range.end = Math.max(range.end, rangeHint.end)
  }
  rangeRef.current = range
  return { range, onRange, sync, measure, reveal: (index: number) => { setRangeHint(null); setAnchor({key:keys[index] ?? '',index,offset:0}) }, height: (key: string, estimate = 160) => heights.current.get(key) ?? estimate, selected: selected.current }
}

/** Mounted bodies own bounds subscriptions and active row leases. Native
 * semantic metadata preserves identity and height after the whole slot leaves. */
export const TranscriptSlot = memo(function TranscriptSlot({ rowKey, mounted, height, children, measure, sync }: {
  rowKey: string; mounted: boolean; height: number; children: ReactNode
  measure: (key: string, height: number) => void; sync: (frame?: number) => void
}) {
  const renderer = useGpuixRequired()
  const retention = useContext(SparseRetention)
  const node = useRef<PublicInstance | null>(null)
  const [focused, setFocused] = useState(false)
  const [leases, setLeases] = useState(0)
  const acquire = useCallback(() => {
    let active = true
    setLeases(n => n + 1)
    return () => { if(active) { active = false; setLeases(n => n - 1) } }
  }, [])
  const [resizing, setResizing] = useState(false)
  const lastHeight = useRef<number | null>(null)
  const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(settle.current), [])
  const keep = mounted || focused || leases > 0 || resizing
  useLayoutEffect(() => { retention?.retain(rowKey, focused || leases > 0 || resizing); return () => retention?.retain(rowKey, false) }, [retention, rowKey, focused, leases, resizing])
  const lifetime = useRef({mounted:false, count:retention?.visited.has(rowKey) ? 1 : 0})
  if(keep && !lifetime.current.mounted) { lifetime.current.count++; retention?.visited.add(rowKey) }
  lifetime.current.mounted = keep
  useEffect(() => {
    if(!node.current || !keep) return
    return observeElementBounds(renderer, node.current.id, ({rect,frame}) => {
      if(rect) {
        measure(rowKey, rect.height)
        // Disclosure height/opacity motions take 220ms. Keep their owner
        // through the final geometry paint and a short settled grace period.
        if(lastHeight.current !== null && Math.abs(lastHeight.current - rect.height) > 0.5) {
          setResizing(true)
          clearTimeout(settle.current)
          settle.current = setTimeout(() => setResizing(false), 300)
        }
        lastHeight.current = rect.height
      }
      sync(frame)
    })
  }, [renderer,keep,rowKey,measure,sync])
  return <div ref={node} testId={`transcript-slot:${rowKey}`} onFocus={keep ? () => setFocused(true) : undefined} onBlur={keep ? () => setFocused(false) : undefined} style={{display:'flex',flexDirection:'column',width:'100%',...(!keep ? {height} : {})}}>{keep ? <RowLease.Provider value={acquire}><FirstBodyMount.Provider value={lifetime.current.count === 1}>{children}</FirstBodyMount.Provider></RowLease.Provider> : null}</div>
})
