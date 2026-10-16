import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useGpuixRequired, type PublicInstance } from '@gpuix/react'
import { FILL_ISLAND } from '../MatrixLoader.tsx'
import { getNav } from '../nav/store.ts'
import { revealTask, slotRef, taskVisible, taskScrollRef, useHeldTask } from './drag.tsx'
import { useTasks } from './store.ts'
import { observeElementBounds } from '../native/layout.ts'
import { taskWindowRange } from './windowRange.ts'

export interface TaskWindowEntry {
  key: string
  height: number
  render: () => ReactNode
  pinned?: boolean
  /** Native wrapped content owns this row's height; `height` is only its unmounted estimate. */
  intrinsic?: boolean
}

/** Native virtualization bounds paint/layout; this also bounds mounted React row trees. */
export function TaskWindow({ entries, card = false, testId }: { entries: TaskWindowEntry[]; card?: boolean; testId?: string }) {
  const renderer = useGpuixRequired()
  const list = useRef<PublicInstance | null>(null)
  const liveEntries = useRef(entries)
  liveEntries.current = entries
  const anchorFrame = useRef(-1)
  const [viewport, setViewport] = useState<PublicInstance | null>(null)
  const [viewportHeight, setViewportHeight] = useState(820)
  const [measured, setMeasured] = useState<Record<string, number>>({})
  const focused = useTasks((s) => s.focused)
  const held = useHeldTask()
  const overscan = card ? 2 : 4
  const [anchor, setAnchor] = useState({ key: '', index: 0 })
  const syncAnchor = useCallback((frame?: number) => {
    if (!list.current || (frame !== undefined && anchorFrame.current === frame)) return
    if (frame !== undefined) anchorFrame.current = frame
    const scroll = renderer.getListScrollTop?.(list.current.id)
    if (!scroll) return
    const index = scroll[0] ?? 0, key = liveEntries.current[index]?.key ?? ''
    setAnchor(old => old.key === key && old.index === index ? old : {key, index})
  }, [renderer])
  const heights = entries.map(entry => measured[entry.key] ?? entry.height)
  const entryKeys = entries.map(entry => entry.key).join('\0')
  useEffect(() => {
    const keys = new Set(entryKeys.split('\0'))
    setMeasured(old => Object.keys(old).some(key => !keys.has(key)) ? Object.fromEntries(Object.entries(old).filter(([key]) => keys.has(key))) : old)
  }, [entryKeys])
  const at = entries.findIndex(entry => entry.key === anchor.key)
  const range = taskWindowRange(heights, at < 0 ? anchor.index : at, viewportHeight, overscan)
  const measure = useCallback((key: string, height: number) => {
    if (height <= 0 || !Number.isFinite(height)) return
    setMeasured(old => Math.abs((old[key] ?? 0) - height) < 0.5 ? old : { ...old, [key]: height })
  }, [])
  useEffect(() => {
    if (!viewport) return
    let width = 0
    return observeElementBounds(renderer, viewport.id, ({rect}) => {
      if (!rect) return
      setViewportHeight(rect.height)
      // Heights measured at another wrap width cannot stand in for unmounted cards.
      if (width && Math.abs(width - rect.width) > 0.5) setMeasured({})
      width = rect.width
    })
  }, [renderer, viewport])
  useEffect(() => {
    if (!focused || !getNav().keyboardNav || !list.current) return
    const index = entries.findIndex((entry) => entry.key === focused)
    if (index < 0) return
    revealTask(focused, renderer)
    if (taskVisible(focused, renderer)) return
    renderer.scrollToItem?.(list.current.id, index)
  }, [focused])
  return (
    <div {...FILL_ISLAND} ref={setViewport} style={{ display: 'flex', flexGrow: 1, minHeight: 0, width: '100%' }}>
    <virtual-list
      ref={(node) => { taskScrollRef(node, list.current, entries.length, (index) => { const key = entries[index]?.key ?? ''; setAnchor(old => old.key === key && old.index === index ? old : {key, index}) }, heights, viewport, entries.map(entry => entry.key)); list.current = node }}
      testId={testId}
      estimatedItemHeight={card ? 122 : 40}
      overdraw={card ? 128 : 120}
      onVisibleRange={(event) => {
        if (process.env.KYBERN_DEBUG_DRAG === '1') console.error('[task-range]', JSON.stringify({list:list.current?.id, start:event.startIndex, end:event.endIndex, count:entries.length, anchor: list.current && renderer.getListScrollTop?.(list.current.id)}))
        const index = (list.current && renderer.getListScrollTop?.(list.current.id)?.[0]) ?? event.startIndex ?? 0
        const key = entries[index]?.key ?? ''
        setAnchor(old => old.key === key && old.index === index ? old : {key, index})
      }}
      style={{ flexGrow: 1, minHeight: 0, width: '100%' }}
    >
      {entries.map((entry, index) => (
        <TaskSlot key={entry.key} entry={entry} height={heights[index]!} mounted={!!entry.pinned || entry.key === focused || entry.key === held || (index >= range.start && index < range.end)} measure={measure} syncAnchor={syncAnchor} />
      ))}
    </virtual-list>
    </div>
  )
}

function TaskSlot({entry, height, mounted, measure, syncAnchor}: {entry: TaskWindowEntry; height: number; mounted: boolean; measure: (key: string, height: number) => void; syncAnchor: (frame: number) => void}) {
  const renderer = useGpuixRequired()
  const [node, setNode] = useState<PublicInstance | null>(null)
  useEffect(() => {
    if (!node || !mounted) return
    // Native cached-list scrolling can paint new placeholder slots without a
    // fresh visibleRange event. Bounds notifications still report that paint;
    // read its actual logical anchor once per frame to mount the new content.
    return observeElementBounds(renderer, node.id, ({rect, frame}) => { if (rect && entry.intrinsic) measure(entry.key, rect.height); syncAnchor(frame) })
  }, [renderer, node, mounted, entry.intrinsic, entry.key, measure, syncAnchor])
  return <div testId={`task-slot-${entry.key}`} ref={useCallback((value: PublicInstance | null) => { slotRef(entry.key, value); setNode(value) }, [entry.key])} style={{ ...(mounted && entry.intrinsic ? {} : {height}), flexShrink: 0, width: '100%' }}>
    {mounted ? entry.render() : null}
  </div>
}
