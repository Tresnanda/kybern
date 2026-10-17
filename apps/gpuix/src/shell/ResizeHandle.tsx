// The drag handle between the thread panel and the content card
// (`components/kybern/ResizeHandle.tsx`): a 16px invisible hit area straddling
// the seam, and a 2px line that shows on hover and while dragging.
//
// GPUIX delivers mouse moves only to the element under the pointer, so a drag
// raises a transparent layer over the whole window (`SidebarDragLayer`) that
// follows the pointer and ends on release. Both are plain elements: an
// `<anchored>` layer would paint an opaque backing under its (transparent)
// content. The width lives outside App's render: a drag updates one number
// (`layout.ts`) and the frame re-lays out; nothing in the transcript is rebuilt.
import { useState } from 'react'
import { motion } from '@gpuix/react'
import { REDUCED_MOTION, useTheme } from '../ui.tsx'
import {
  dragSidebarTo,
  effectiveSidebarWidth,
  setSidebarDragging,
  useSidebarDragging,
  useSidebarWidth,
} from './layout.ts'

/** Where the drag started: the pointer's x and the panel's width then. */
const origin = { x: 0, width: 0 }

/**
 * Mount once as the last child of the row that holds the panel and the card
 * while the panel is open; it straddles the panel's trailing edge. Its line is
 * `pointerEvents: none`: GPUIX hit-tests a child before its parent, so a plain
 * child over the middle of the handle would swallow the press.
 */
export function SidebarResizeHandle() {
  const t = useTheme()
  const width = useSidebarWidth()
  const dragging = useSidebarDragging()
  const [hover, setHover] = useState(false)
  // `bg-sidebar-border` (`--sidebar-border` = `--color-border`).
  const shown = hover || dragging
  return (
    <div
      testId="sidebar-resize"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onMouseDown={(e) => {
        origin.x = e.x ?? 0
        origin.width = effectiveSidebarWidth()
        setSidebarDragging(true)
      }}
      style={{ position: 'absolute', left: width - 8, top: 0, bottom: 0, width: 16, cursor: 'col-resize' }}
    >
      <motion.div initial={false} animate={{ opacity: shown ? 1 : 0 }} transition={{ duration: REDUCED_MOTION ? 0 : shown ? 0.12 : 0.2, ease: [0.23, 1, 0.32, 1] }} style={{ position: 'absolute', left: 7, top: 0, bottom: 0, width: 2, backgroundColor: t.border, pointerEvents: 'none' }} />
    </div>
  )
}

/** Mount last in the window's root; it renders nothing until a drag starts. */
export function SidebarDragLayer() {
  return useSidebarDragging() ? (
    <div
      testId="sidebar-drag-layer"
      onMouseMove={(e) => {
        if (e.pressedButton !== 0) return setSidebarDragging(false)
        dragSidebarTo(origin.width + ((e.x ?? 0) - origin.x))
      }}
      onMouseUp={() => setSidebarDragging(false)}
      onMouseLeave={() => setSidebarDragging(false)}
      style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', cursor: 'col-resize' }}
    />
  ) : null
}
