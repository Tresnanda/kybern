// The drag handle between the thread panel and the content card
// (`components/kybern/ResizeHandle.tsx`): a 16px invisible hit area straddling
// the seam, and a 2px line that shows on hover and while dragging.
//
// It is an `<anchored>` layer: plain elements beside the cached islands (the
// panel and the card) never receive the pointer, anchored layers do (as menus
// and dialogs show). GPUIX also delivers mouse moves only to the element under
// the pointer, so a drag raises a transparent layer over the whole window
// (`SidebarDragLayer`) that follows the pointer and ends on release. The width
// lives outside App's render: a drag updates one number (`layout.ts`) and the
// frame re-lays out; nothing in the transcript is rebuilt for it.
import { useState } from 'react'
import { PopupLayer } from '../composer/Menu.tsx'
import { useTheme } from '../ui.tsx'
import {
  dragSidebarTo,
  effectiveSidebarWidth,
  setSidebarDragging,
  useSidebarDragging,
  useSidebarWidth,
  useWindowSizeSnapshot,
} from './layout.ts'

/** The title bar's height and the rail's width (`nav/TitleBar.tsx`), and the frame inset (`App.tsx`). */
const TITLEBAR = 46
const RAIL = 52
const INSET = 8

/** Where the drag started: the pointer's x and the panel's width then. */
const origin = { x: 0, width: 0 }

/** Mount once in the window's tree while the panel is open; it straddles the panel's trailing edge. */
export function SidebarResizeHandle() {
  const t = useTheme()
  const width = useSidebarWidth()
  const dragging = useSidebarDragging()
  const size = useWindowSizeSnapshot()
  const [hover, setHover] = useState(false)
  if (!size.height) return null
  // `bg-sidebar-border` (`--sidebar-border` = `--color-border`).
  const line = hover || dragging ? t.border : 'transparent'
  return (
    <PopupLayer
      still
      position={{ x: RAIL + width - 8, y: TITLEBAR }}
      anchor="topLeft"
      priority={2}
      testId="sidebar-resize"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onMouseDown={(e) => {
        origin.x = e.x ?? 0
        origin.width = effectiveSidebarWidth()
        setSidebarDragging(true)
      }}
      style={{ position: 'relative', width: 16, height: size.height - TITLEBAR - INSET, cursor: 'col-resize' }}
    >
      <div style={{ position: 'absolute', left: 7, top: 0, bottom: 0, width: 2, backgroundColor: line, pointerEvents: 'none' }} />
    </PopupLayer>
  )
}

/** Mount once at the end of the window's tree; it renders nothing until a drag starts. */
export function SidebarDragLayer() {
  return useSidebarDragging() ? <DragLayer /> : null
}

function DragLayer() {
  const size = useWindowSizeSnapshot()
  return (
    <PopupLayer
      still
      position={{ x: 0, y: 0 }}
      anchor="topLeft"
      priority={5}
      testId="sidebar-drag-layer"
      onMouseMove={(e) => {
        if (e.pressedButton !== 0) return setSidebarDragging(false)
        dragSidebarTo(origin.width + ((e.x ?? 0) - origin.x))
      }}
      onMouseUp={() => setSidebarDragging(false)}
      onMouseLeave={() => setSidebarDragging(false)}
      style={{ width: size.width, height: size.height, cursor: 'col-resize' }}
    />
  )
}
