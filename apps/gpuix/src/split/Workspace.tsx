import { ThreadHeader } from '../nav/TitleBar.tsx'
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useGpuixRequired, type PublicInstance, type EventPayload } from '@gpuix/react'
import { dropZoneAt, splitForZone, type DropZone } from './geometry.ts'
import { clampSplitRatioForWidth, shouldStackHorizontalSplit } from '../../../desktop/src/state/splitView.ts'
import { PaneProvider, focusPane, getPane, selectPaneThread, useApp } from '../state.ts'
import { observeElementBounds, type LayoutRect } from '../native/layout.ts'
import { Label, useTheme } from '../ui.tsx'
import { Button, Para, alpha } from '../transcript/kit.tsx'
import { addWindowKeyHandler } from '../nav/keys.ts'
import { onEnvironmentChange } from '../shell/environment.ts'
import { canSplitPane, collectThreadPanes, closePane, getSplitRoot, resizePane, splitPane, useFocusedPane, useSplitRoot, type Pane } from './store.ts'

const bounds = new Map<string, LayoutRect>()
type Drag = { kind: 'resize'; id: string; horizontal: boolean; rect: LayoutRect } | { kind: 'thread'; id: string; x: number; y: number; target?: { id: string; zone: DropZone } }
let drag: Drag | null = null
let pending: { id: string; x: number; y: number } | null = null
let stopSelection: (() => void) | undefined
let suppressedUntil = 0
const listeners = new Set<() => void>()
function publish(next: Drag | null) { drag = next; for (const listener of listeners) listener() }
export const useSplitDragging = () => useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => drag !== null)
const useDrag = () => useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => drag)
export function beginThreadDrag(id: string, e: EventPayload, clearSelection?: () => void) {
  if (e.button === 0 && e.x != null && e.y != null) { pending = { id, x: e.x, y: e.y }; stopSelection = clearSelection }
}
export function trackThreadDrag(e: EventPayload) {
  if (drag) { moveSplitDrag(e); return }
  if (!pending) return
  if (e.pressedButton !== 0) { pending = null; return }
  if (Math.hypot((e.x ?? 0) - pending.x, (e.y ?? 0) - pending.y) < 6) return
  stopSelection?.()
  publish({ kind: 'thread', ...pending }); pending = null
}
export function cancelPendingThreadDrag() { pending = null }
export function consumeThreadDrag() { pending = null; return Date.now() < suppressedUntil }
function cancel() { pending = null; publish(null) }
onEnvironmentChange(() => { cancel(); bounds.clear() })

export function SplitWorkspace({ children }: { children: ReactNode }) {
  const root = useSplitRoot()
  return <PaneTree pane={root} split={root.kind === 'split'}>{children}</PaneTree>
}
function PaneTree({ pane, split, children }: { pane: Pane; split: boolean; children: ReactNode }) {
  return pane.kind === 'leaf'
    ? <Leaf id={pane.id} split={split}>{children}</Leaf>
    : <Branch pane={pane}>{children}</Branch>
}
function Branch({ pane, children }: { pane: Extract<Pane, { kind: 'split' }>; children: ReactNode }) {
  const renderer = useGpuixRequired(), t = useTheme()
  const [node, ref] = useState<PublicInstance | null>(null)
  const [rect, setRect] = useState<LayoutRect | null>(null)
  const [hover, setHover] = useState(false)
  useEffect(() => node ? observeElementBounds(renderer, node.id, event => setRect(event.rect)) : undefined, [node, renderer])
  const horizontal = pane.direction === 'horizontal' && !shouldStackHorizontalSplit(rect?.width ?? Infinity)
  const ratio = clampSplitRatioForWidth(pane.ratio, horizontal ? rect?.width ?? Infinity : Infinity)
  return <div ref={ref} testId={`split-${pane.id}`} style={{ display: 'flex', flexDirection: horizontal ? 'row' : 'column', flexGrow: 1, minWidth: 0, minHeight: 0, overflow: 'hidden', position: 'relative' }}>
    <div style={{ display: 'flex', flexBasis: 0, flexGrow: ratio, flexShrink: 0, minWidth: 0, minHeight: 0, borderRightWidth: horizontal ? 1 : 0, borderBottomWidth: horizontal ? 0 : 1, borderColor: t.border }}><PaneTree pane={pane.first} split>{children}</PaneTree></div>
    <div style={{ display: 'flex', flexBasis: 0, flexGrow: 1 - ratio, minWidth: 0, minHeight: 0 }}><PaneTree pane={pane.second} split>{children}</PaneTree></div>
    <div testId={`split-resize-${pane.id}`} role="separator" tabIndex={0} aria-label="Resize thread panes"
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      onMouseDown={() => { if (rect) publish({ kind: 'resize', id: pane.id, horizontal, rect }) }}
      onKeyDown={e => { const delta = e.key === 'left' || e.key === 'up' ? -.05 : e.key === 'right' || e.key === 'down' ? .05 : 0; if (delta) resizePane(pane.id, ratio + delta); else if (e.key === 'home' || e.key === 'end') resizePane(pane.id, e.key === 'home' ? .25 : .75) }}
      style={{ position: 'absolute', ...(horizontal ? { left: (rect?.width ?? 0) * ratio, top: 0, bottom: 0, width: 16, marginLeft: -8 } : { top: (rect?.height ?? 0) * ratio, left: 0, right: 0, height: 16, marginTop: -8 }), cursor: horizontal ? 'col-resize' : 'row-resize' }}>
      <div style={{ position: 'absolute', ...(horizontal ? { left: 7, width: 2, top: 0, bottom: 0 } : { top: 7, height: 2, left: 0, right: 0 }), backgroundColor: hover ? t.border : 'transparent', pointerEvents: 'none' }} />
    </div>
  </div>
}
function Leaf({ id, split, children }: { id: string; split: boolean; children: ReactNode }) {
  const renderer = useGpuixRequired()
  const t = useTheme(), focused = useFocusedPane() === id
  const [node, ref] = useState<PublicInstance | null>(null)
  useEffect(() => {
    if (!node) return
    const stop = observeElementBounds(renderer, node.id, event => { if (event.rect) bounds.set(id, event.rect); else bounds.delete(id) })
    return () => { stop(); bounds.delete(id) }
  }, [renderer, node, id])
  return <PaneProvider id={id} compact={split}><div ref={ref} testId={`pane-${id}`} onMouseDown={() => focusPane(id)} onFocus={() => focusPane(id)} style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0, minHeight: 0, overflow: 'hidden', position: 'relative' }}>
    {split && <PaneHeader id={id} />}
    <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0, position: 'relative' }}><LeafContent id={id} split={split}>{children}</LeafContent></div>
    {split && focused && <div style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, borderWidth: 1, borderColor: alpha(t.v('--color-border-focus'), .28), pointerEvents: 'none' }} />}
  </div></PaneProvider>
}
function LeafContent({ id, split, children }: { id: string; split: boolean; children: ReactNode }) {
  const selected = useApp(s => s.selectedId)
  const threads = useApp(s => s.threads)
  const [draft, showDraft] = useState(false)
  const t = useTheme()
  if (!split || selected || draft) return children
  const openIds = new Set(collectThreadPanes(getSplitRoot()).map(p => p.threadId))
  const recent = threads.filter(thread => !thread.subagent && !thread.delegation && thread.status !== 'archived' && !openIds.has(thread.id)).slice(0, 6)
  return <div testId={`pane-empty-${id}`} style={{ display: 'flex', flexGrow: 1, minHeight: 0, alignItems: 'center', justifyContent: 'center', padding: 24 }}><div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', maxWidth: 288, gap: 8 }}>
    <Label color={t.text} size={13} weight={500}>Start a conversation</Label>
    <Para color={t.textSecondary} size={11}>Start a new thread, choose a recent one, or drag one here.</Para>
    <Button testId={`pane-new-${id}`} onClick={() => { focusPane(id); showDraft(true) }}>New thread</Button>
    {recent.map(thread => <Button key={thread.id} variant="ghost" testId={`pane-recent-${id}-${thread.id}`} onClick={() => { focusPane(id); void selectPaneThread(id, thread.id) }}>{thread.title || 'Untitled'}</Button>)}
    <Button variant="chrome-outline" onClick={() => closePane(id)}>Close pane</Button>
  </div></div>
}
function PaneHeader({ id }: { id: string }) {
  const t = useTheme()
  return <div testId={`pane-header-${id}`} onMouseDown={() => focusPane(id)} onClick={() => focusPane(id)} style={{ display: 'flex', alignItems: 'center', height: 46, flexShrink: 0, paddingLeft: 20, paddingRight: 20, gap: 8, borderBottomWidth: 1, borderColor: t.border }}><ThreadHeader paneId={id} /></div>
}
export function moveSplitDrag(e: EventPayload) {
  const current = drag
  if (!current) return
    if (e.eventType === 'mouseMove' && e.pressedButton !== 0) return cancel()
    if (e.x == null || e.y == null) return
    const x = e.x ?? 0, y = e.y ?? 0
    if (current.kind === 'resize') {
      const b = current.rect
      resizePane(current.id, clampSplitRatioForWidth(current.horizontal ? (x - b.x) / b.width : (y - b.y) / b.height, current.horizontal ? b.width : Infinity))
    } else {
      let next: { id: string; zone: DropZone } | undefined
      for (const [id, b] of bounds) {
        const zone = dropZoneAt({ left: b.x, top: b.y, width: b.width, height: b.height }, x, y, direction => !getPane(id)?.selectedId || canSplitPane(getSplitRoot(), id, direction))
        if (zone) { next = { id, zone }; break }
      }
      publish({ ...current, x, y, target: next })
    }
  }

export function finishSplitDrag() {
  const current = drag
  if (!current) { pending = null; return }
  const target = current.kind === 'thread' ? current.target : undefined
    if (current.kind === 'thread' && target) {
      if (!getPane(target.id)?.selectedId) { focusPane(target.id); void selectPaneThread(target.id, current.id) }
      else { const { direction, side } = splitForZone(target.zone); splitPane(target.id, direction, current.id, side) }
      suppressedUntil = Date.now() + 250
    }
    cancel()

}
export function SplitDragLayer() {
  const current = useDrag(), t = useTheme()
  useEffect(() => addWindowKeyHandler(e => { if (e.key === 'escape' && (drag || pending)) { cancel(); return true } }), [])
  if (!current) return null
  const target = current.kind === 'thread' ? current.target : undefined
  const rect = target ? bounds.get(target.id) : undefined
  const whole = target && !getPane(target.id)?.selectedId
  const zone = target?.zone
  return <div key={current.kind} testId="split-drag-layer" onMouseEnter={moveSplitDrag} onMouseMove={moveSplitDrag} onMouseLeave={cancel} onMouseUp={finishSplitDrag} style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', pointerEvents: 'auto', userSelect: 'none', cursor: current.kind === 'resize' ? current.horizontal ? 'col-resize' : 'row-resize' : 'grabbing' }}>
    {current.kind === 'thread' && <div style={{ position: 'absolute', left: current.x + 12, top: current.y + 12, width: 240, padding: 10, borderRadius: 10, backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, pointerEvents: 'none' }}><Label color={t.text} size={12}>Move conversation</Label></div>}
    {rect && zone && <div testId="pane-drop-highlight" style={{ position: 'absolute', left: rect.x + 8 + (!whole && zone === 'right' ? rect.width / 2 : 0), top: rect.y + 8 + (!whole && zone === 'bottom' ? rect.height / 2 : 0), width: rect.width / (!whole && (zone === 'left' || zone === 'right') ? 2 : 1) - 16, height: rect.height / (!whole && (zone === 'top' || zone === 'bottom') ? 2 : 1) - 16, borderRadius: 10, borderWidth: 1, borderColor: t.link, backgroundColor: t.buttonSecondary, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}><Label color={t.text} weight={500}>{whole ? 'Open here' : ({ left: 'Split left', right: 'Split right', top: 'Split above', bottom: 'Split below' })[zone]}</Label></div>}
  </div>
}
