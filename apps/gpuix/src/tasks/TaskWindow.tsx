import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useGpuixRequired, type PublicInstance } from '@gpuix/react'
import { getNav } from '../nav/store.ts'
import { revealTask, slotRef, taskVisible, taskScrollRef } from './drag.tsx'
import { useTasks } from './store.ts'

export interface TaskWindowEntry {
  key: string
  height: number
  render: () => ReactNode
  pinned?: boolean
}

/** Native virtualization bounds paint/layout; this also bounds mounted React row trees. */
export function TaskWindow({ entries, card = false, testId }: { entries: TaskWindowEntry[]; card?: boolean; testId?: string }) {
  const renderer = useGpuixRequired()
  const list = useRef<PublicInstance | null>(null)
  const focused = useTasks((s) => s.focused)
  const overscan = card ? 2 : 4
  const [range, setRange] = useState({ start: 0, end: card ? 8 : 24 })
  useEffect(() => {
    if (!focused || !getNav().keyboardNav || !list.current) return
    const index = entries.findIndex((entry) => entry.key === focused)
    if (index < 0) return
    revealTask(focused, renderer)
    if (taskVisible(focused, renderer)) return
    renderer.scrollToItem?.(list.current.id, index)
  }, [focused])
  return (
    <virtual-list
      ref={(node) => { taskScrollRef(node, list.current, entries.length, (index) => setRange((old) => { const start = Math.min(old.start, Math.max(0, index - overscan)); const end = Math.max(old.end, Math.min(entries.length, index + (card ? 8 : 24))); return start === old.start && end === old.end ? old : { start, end } }), entries.map((entry) => entry.height)); list.current = node }}
      testId={testId}
      estimatedItemHeight={card ? 122 : 40}
      overdraw={card ? 128 : 120}
      onVisibleRange={(event) => {
        const start = Math.max(0, (event.startIndex ?? 0) - overscan)
        const end = Math.min(entries.length, (event.endIndex ?? 20) + overscan)
        setRange((old) => (old.start === start && old.end === end ? old : { start, end }))
      }}
      style={{ flexGrow: 1, minHeight: 0, width: '100%' }}
    >
      {entries.map((entry, index) => (
        <div key={entry.key} ref={(node) => slotRef(entry.key, node)} style={{ height: entry.height, width: '100%' }}>
          {entry.pinned || entry.key === focused || (index >= range.start && index < range.end) ? entry.render() : null}
        </div>
      ))}
    </virtual-list>
  )
}
