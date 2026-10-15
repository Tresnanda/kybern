import '../native/backdrop.ts'
import { useGpuix, type PublicInstance, type EventPayload } from '@gpuix/react'
import { observeElementBounds, type LayoutRect } from '../native/layout.ts'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { getNav } from '../nav/store.ts'
import { DURATION, EASE } from '../motion/kit.tsx'
import { load, save } from '../shell/persist.ts'
import { cornerPosition, nearestCorner } from '../../../../packages/kybern-client/src/previewMiniPlayer.ts'
import { REDUCED_MOTION, useTheme } from '../ui.tsx'
import { useComposerOverlayHeight } from '../composer/height.ts'
type Corner = 'top-end' | 'top-start' | 'bottom-end' | 'bottom-start'
const corners: Corner[] = ['top-end', 'top-start', 'bottom-end', 'bottom-start']
/** Shared native corner snap. The overlay exists only during the drag. */
export function Floating({ storageKey, width, height, testId, children, insetEnd = 0, insetBottom: explicitInset = 0, overlayDrag = false }: { storageKey: string; width: number; height: number; testId: string; children: ReactNode; insetEnd?: number; insetBottom?: number; overlayDrag?: boolean }) {
  // Bottom corners sit above the composer and its request panels, as on the desktop.
  const insetBottom = Math.max(explicitInset, useComposerOverlayHeight())
  const t = useTheme()
  const { renderer } = useGpuix()
  const card = useRef<PublicInstance | null>(null)
  const container = useRef<PublicInstance | null>(null)
  const [corner, setCorner] = useState<Corner>(() => { const saved = load<Corner>(storageKey, 'top-end'); return corners.includes(saved) ? saved : 'top-end' })
  const samples = useRef<{ x: number; y: number; time: number }[]>([])
  const generation = useRef(0)
  const entered = useRef(REDUCED_MOTION || getNav().keyboardNav)
  const [snap, setSnap] = useState<{ generation: number; x: number; y: number; vx: number; vy: number } | null>(null)
  const [drag, setDrag] = useState<{ x: number; y: number; left: number; top: number; dx: number; dy: number; parentX: number; parentY: number; parentWidth: number; parentHeight: number } | null>(null)
  const parent = useRef<LayoutRect | null>(null)
  useEffect(() => {
    if (!renderer || !container.current) return
    return observeElementBounds(renderer, container.current.id, event => {
      const before = parent.current, next = event.rect
      parent.current = next
      if (before && next && (before.width !== next.width || before.height !== next.height)) {
        setDrag(null); setSnap(null)
      }
    })
  }, [renderer])
  const finish = () => {
    if (!drag) return
    renderer?.clearSelection?.()
    const recent = samples.current.filter(sample => Date.now() - sample.time <= 100)
    const first = recent[0], last = recent.at(-1), span = first && last ? last.time - first.time : 0
    const velocity = span > 0 ? { x: (last!.x - first!.x) * 1000 / span, y: (last!.y - first!.y) * 1000 / span } : { x: 0, y: 0 }
    const position = { x: drag.left + drag.dx, y: drag.top + drag.dy }
    const bounds = { w: Math.max(width + 24, drag.parentWidth - insetEnd), h: drag.parentHeight }
    const size = { w: width, h: height }
    const projected = nearestCorner(position, velocity, size, bounds, { bottomInset: 12 + insetBottom })
    const next = projected.replace('left', 'start').replace('right', 'end') as Corner
    const target = cornerPosition(projected, size, bounds, { bottomInset: 12 + insetBottom })
    setSnap(REDUCED_MOTION ? null : { generation: ++generation.current, x: position.x - target.x, y: position.y - target.y, vx: velocity.x, vy: velocity.y })
    setCorner(next); save(storageKey, next); setDrag(null)
  }
  const move = (e: EventPayload) => {
    if (!drag) return
    if (e.pressedButton !== 0) { finish(); return }
    if (e.x === undefined || e.y === undefined) return
    renderer?.clearSelection?.()
    const now = Date.now()
    samples.current = [...samples.current.filter(sample => now - sample.time <= 100), { x: e.x, y: e.y, time: now }].slice(-16)
    setDrag({ ...drag, dx: e.x - drag.x, dy: e.y - drag.y })
  }
  const horizontal = corner.endsWith('end') ? { right: 12 + insetEnd } : { left: 12 }
  const vertical = corner.startsWith('top') ? { top: 12 } : { bottom: 12 + insetBottom }
  return <div ref={container} testId={`${testId}-bounds`} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, pointerEvents: 'none' }}>
    <div style={{ position: 'absolute', width, height, ...(drag ? { left: drag.left + drag.dx, top: drag.top + drag.dy } : { ...horizontal, ...vertical }), pointerEvents: 'none' }}>
    <anchored backdrop={{blur:0}} side="bottom" align="start" gap={-height} deferred priority={0} occlude snapMargin={8}
      {...(!drag && snap && !REDUCED_MOTION ? { motion: { generation: snap.generation, isExit: false, initial: { translateX: snap.x, translateY: snap.y }, animate: { translateX: 0, translateY: 0 }, transition: { type: 'spring', duration: 0.4, bounce: 0, velocityX: snap.vx, velocityY: snap.vy } } } as object : !drag && !entered.current ? { motion: { generation: 0, isExit: false, initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: DURATION.fast, ease: [...EASE.smoothOut] } } } as object : {})}
      onMotionComplete={() => { entered.current = true }}
      style={{ borderRadius: 16 }}>
    <div ref={card} testId={testId} onMouseUp={finish} style={{ display: 'flex', flexDirection: 'column', width, height, borderRadius: 16, backgroundColor: t.popover, borderWidth: 0.6, borderColor: t.border, overflow: 'hidden', pointerEvents: 'auto', boxShadow: { offsetX: 0, offsetY: 8, blurRadius: 24, spreadRadius: 0, color: 'rgba(0,0,0,0.2)' } }}>
      <div testId={`${testId}-drag`} aria-label="Move preview" onMouseUp={finish} onMouseMove={move} onMouseDown={e => {
        if (e.button !== 0 || e.x === undefined || e.y === undefined || !card.current || !container.current) return
        const b = renderer?.getElementBounds?.(card.current.id), p = parent.current ?? renderer?.getElementBounds?.(container.current.id)
        renderer?.clearSelection?.(); entered.current = true; samples.current = [{ x: e.x, y: e.y, time: Date.now() }]; setSnap(null)
        if (b && p) setDrag({ x: e.x, y: e.y, left: b.x - p.x, top: b.y - p.y, dx: 0, dy: 0, parentX: p.x, parentY: p.y, parentWidth: p.width, parentHeight: p.height })
      }} style={{ ...(overlayDrag ? { position: 'absolute' as const, top: 0, left: 0, right: 72, height: 24, zIndex: 2 } : { height: 10 }), flexShrink: 0, cursor: 'grab', userSelect: 'none', backgroundColor: overlayDrag ? 'transparent' : t.buttonSecondary }} />
      {children}
    </div>
    </anchored>
    </div>
    {drag && <div testId={`${testId}-capture`} onMouseMove={move} onMouseUp={finish} onMouseDownOutside={finish} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, pointerEvents: 'auto', userSelect: 'none', cursor: 'grabbing' }} />}
  </div>
}
