import { useGpuix, type PublicInstance } from '@gpuix/react'
import { useRef, useState, type ReactNode } from 'react'
import { getNav } from '../nav/store.ts'
import { load, save } from '../shell/persist.ts'
import { PopupLayer } from '../composer/Menu.tsx'
import { REDUCED_MOTION, useTheme } from '../ui.tsx'
type Corner = 'top-end' | 'top-start' | 'bottom-end' | 'bottom-start'
const corners: Corner[] = ['top-end', 'top-start', 'bottom-end', 'bottom-start']
/** Shared native corner snap. The overlay exists only during the drag. */
export function Floating({ storageKey, width, height, testId, children, insetEnd = 0 }: { storageKey: string; width: number; height: number; testId: string; children: ReactNode; insetEnd?: number }) {
  const t = useTheme()
  const { renderer } = useGpuix()
  const card = useRef<PublicInstance | null>(null)
  const container = useRef<PublicInstance | null>(null)
  const [corner, setCorner] = useState<Corner>(() => { const saved = load<Corner>(storageKey, 'top-end'); return corners.includes(saved) ? saved : 'top-end' })
  const [drag, setDrag] = useState<{ x: number; y: number; left: number; top: number; dx: number; dy: number; parentX: number; parentY: number; parentWidth: number; parentHeight: number } | null>(null)
  const finish = () => {
    if (!drag) return
    const next: Corner = `${drag.top + drag.dy + height / 2 < drag.parentHeight / 2 ? 'top' : 'bottom'}-${drag.left + drag.dx + width / 2 < drag.parentWidth / 2 ? 'start' : 'end'}`
    setCorner(next); save(storageKey, next); setDrag(null)
  }
  const horizontal = corner.endsWith('end') ? { right: 12 + insetEnd } : { left: 12 }
  const vertical = corner.startsWith('top') ? { top: 12 } : { bottom: 12 }
  return <div ref={container} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, pointerEvents: 'none' }}>
    <div style={{ position: 'absolute', width, height, ...(drag ? { left: drag.left + drag.dx, top: drag.top + drag.dy } : { ...horizontal, ...vertical }), pointerEvents: 'none' }}>
    <PopupLayer key={corner} ref={card} testId={testId} side="bottom" sideOffset={-height} still={REDUCED_MOTION || getNav().keyboardNav} fade={{}} priority={0} style={{ display: 'flex', flexDirection: 'column', width, height, borderRadius: 16, backgroundColor: t.popover, borderWidth: 0.6, borderColor: t.border, overflow: 'hidden', pointerEvents: 'auto', boxShadow: { offsetX: 0, offsetY: 8, blurRadius: 24, spreadRadius: 0, color: 'rgba(0,0,0,0.2)' } }}>
      <div testId={`${testId}-drag`} aria-label="Move preview" onMouseDown={e => {
        if (e.button !== 0 || e.x === undefined || e.y === undefined || !card.current || !container.current) return
        const b = renderer?.getElementBounds?.(card.current.id), p = renderer?.getElementBounds?.(container.current.id)
        if (b && p) setDrag({ x: e.x, y: e.y, left: b.x - p.x, top: b.y - p.y, dx: 0, dy: 0, parentX: p.x, parentY: p.y, parentWidth: p.width, parentHeight: p.height })
      }} style={{ height: 10, flexShrink: 0, cursor: 'grab', backgroundColor: t.buttonSecondary }} />
      {children}
    </PopupLayer>
    </div>
    {drag && <div testId={`${testId}-capture`} onMouseMove={e => { if (e.pressedButton !== 0) finish(); else if (e.x !== undefined && e.y !== undefined) setDrag({ ...drag, dx: e.x - drag.x, dy: e.y - drag.y }) }} onMouseUp={finish} onMouseDownOutside={finish} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, pointerEvents: 'auto', cursor: 'grabbing' }} />}
  </div>
}
