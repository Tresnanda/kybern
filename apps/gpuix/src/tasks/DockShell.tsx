// The floating shell both task docks live in (`TaskDock` on a task's page, the batch composer on the list and board): absolute at the
// page's foot, one slot centred in it (660px at most between 16px gutters), a band above it that fades into the opaque page colour
// and an opaque fill behind it, so rows never show through. It reports its height, so the page can leave that much room
// (`dockRoom`). Esc inside the slot calls `onEscape`.
import { useGpuixRequired, type PublicInstance } from '@gpuix/react'
import { useEffect, useRef, type ReactNode } from 'react'
import { observeElementBounds } from '../native/layout.ts'
import { useGlass } from '../platform/glass.ts'
import { alpha } from '../transcript/kit.tsx'
import { useTheme } from '../ui.tsx'

export { dockRoom } from './dockRoom.ts'

/** `.tk-dock[data-filled]`: the gradient band above the dock. */
export const DOCK_BAND = 28
export const DOCK_GUTTER = 16
export const DOCK_FIELD_HEIGHT = 44
/** The slot's content width. */
export const DOCK_WIDTH = 660

export function DockShell({ right = 0, inline = false, onHeight, onEscape, children }: { right?: number; /** In flow inside a positioned wrapper (`Presence`), instead of absolute itself. */ inline?: boolean; onHeight: (height: number) => void; onEscape?: () => void; children: ReactNode }) {
  const t = useTheme()
  const g = useGlass()
  const renderer = useGpuixRequired()
  const node = useRef<PublicInstance | null>(null)
  // The page's bottom padding follows the dock's height (`--tk-dock-h`).
  useEffect(() => {
    const id = node.current?.id
    if (id == null) return
    return observeElementBounds(renderer, id, (event) => { if (event.rect) onHeight(Math.round(event.rect.height)) })
  }, [renderer])
  return (
    <div
      ref={(el) => { node.current = el }}
      testId="task-dock"
      style={{ ...(inline ? { position: 'relative', width: '100%' } : { position: 'absolute', left: 0, right, bottom: 0 }), display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: g.on ? 0 : DOCK_BAND, paddingBottom: DOCK_GUTTER }}
    >
      {/* Opaque for its last 8px: a row passing right above the tray otherwise showed through the nearly opaque tail. Not on whole-window
          glass: there is no colour that equals the desktop behind the window, so the list ends at the dock's top edge instead (`dockRoom`). */}
      {!g.on && <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: DOCK_BAND, pointerEvents: 'none', background: { type: 'linear-gradient', angle: 180, stops: [{ color: alpha(t.surface, 0), position: 0 }, { color: t.surface, position: (DOCK_BAND - 8) / DOCK_BAND }] } }} />}
      {!g.on && <div style={{ position: 'absolute', left: 0, right: 0, top: DOCK_BAND, bottom: 0, pointerEvents: 'none', backgroundColor: t.surface }} />}
      <div
        onKeyDown={onEscape ? (e) => { if (e.key === 'escape' && !e.defaultPrevented) onEscape() } : undefined}
        style={{ position: 'relative', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', width: '100%', maxWidth: DOCK_WIDTH + DOCK_GUTTER * 2, minHeight: DOCK_FIELD_HEIGHT, paddingLeft: DOCK_GUTTER, paddingRight: DOCK_GUTTER }}
      >
        {children}
      </div>
    </div>
  )
}
