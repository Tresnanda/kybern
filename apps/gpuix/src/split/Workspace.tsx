import { BACKDROP } from '../native/backdrop.ts'
import { BACKDROP_ALLOWED } from '../native/backdrop-material.ts'
import { Icon } from '../icons.tsx'
import { N } from '../nav/glyphs.ts'
import { ThreadHeader } from '../nav/TitleBar.tsx'
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { motion, AnimatePresence, useGpuixRequired, type PublicInstance, type EventPayload } from '@gpuix/react'
import { dropZoneAt, splitForZone, type DropZone } from './geometry.ts'
import { clampSplitRatioForWidth, shouldStackHorizontalSplit } from '../../../desktop/src/state/splitView.ts'
import { PaneProvider, focusPane, getPane, selectPaneThread, useApp } from '../state.ts'
import { observeElementBounds, type LayoutRect } from '../native/layout.ts'
import { Label, ProviderMark, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { Button, Para, alpha } from '../transcript/kit.tsx'
import { addWindowKeyHandler } from '../nav/keys.ts'
import { watchPointerRelease } from './release.ts'
import { cls, getObjc, nsApp, sel } from '../native/objc.ts'
import { onEnvironmentChange } from '../shell/environment.ts'
import { DOCKED_INSET, setEnvironmentDock, useEnvironmentPanel } from '../environment/store.ts'
import { canSplitPane, collectThreadPanes, closePane, getSplitRoot, resizePane, splitPane, useFocusedPane, useSplitRoot, type Pane } from './store.ts'

/** The desktop clones the whole sidebar row (it spans the panel minus 6px of inset), whatever depth it sits at. */
const ROW_LEFT = 58
const ROW_WIDTH = 244
const bounds = new Map<string, LayoutRect>()
type Source = { title: string; kind: string; bounds: () => { x: number; y: number; width: number; height: number } | null }
type Ghost = { title: string; kind: string; offX: number; offY: number; width: number; height: number }
type Drag = { kind: 'resize'; id: string; horizontal: boolean; rect: LayoutRect } | { kind: 'thread'; id: string; x: number; y: number; ghost?: Ghost; target?: { id: string; zone: DropZone } }
let drag: Drag | null = null
let pending: { id: string; x: number; y: number; ghost?: Ghost } | null = null
let stopSelection: (() => void) | undefined
let suppressedThread: string | null = null
let stopReleaseWatch: (() => void) | undefined
// Hover-leave is emitted during held-button gestures too. Physical AppKit
// state completes cancellation even when no element receives the outside up.
function watchRelease() {
  stopReleaseWatch?.()
  if (process.platform !== 'darwin') return
  const o = getObjc(), app = nsApp()
  stopReleaseWatch = watchPointerRelease(() => ({
    pressed: (Number(o.msgU64(cls(o, 'NSEvent'), sel(o, 'pressedMouseButtons'))) & 1) !== 0,
    active: !!app && Number(o.msgU64(app, sel(o, 'isActive'))) !== 0,
  }), cancel)
}
const listeners = new Set<() => void>()
function publish(next: Drag | null) { drag = next; for (const listener of listeners) listener() }
export const useSplitDragging = () => useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => drag !== null || pending !== null)
const useDrag = () => useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => drag)
export function beginThreadDrag(id: string, e: EventPayload, clearSelection?: () => void, source?: Source) {
  if (e.button === 0 && e.x != null && e.y != null) {
    // The desktop drags a clone of the pressed row, held where it was grabbed.
    const b = source?.bounds()
    const ghost = source && b ? { title: source.title, kind: source.kind, offX: e.x - ROW_LEFT, offY: e.y - b.y, width: ROW_WIDTH, height: b.height } : undefined
    suppressedThread = null; pending = { id, x: e.x, y: e.y, ghost }; stopSelection = clearSelection; watchRelease(); publish(null) }
}
export function trackThreadDrag(e: EventPayload) {
  if (drag) { moveSplitDrag(e); return }
  if (!pending) return
  if (e.pressedButton !== 0) { cancel(); return }
  if (Math.hypot((e.x ?? 0) - pending.x, (e.y ?? 0) - pending.y) < 6) return
  stopSelection?.()
  const start = pending; pending = null; publish({ kind: 'thread', ...start }); moveSplitDrag(e)
}
export function consumeThreadDrag(id: string) {
  pending = null
  // Native click and mouse-up are separately queued. Suppress the source click
  // on either side of release; the next row press starts a fresh gesture.
  return (drag?.kind === 'thread' && drag.id === id) || suppressedThread === id
}
function cancel() {
  if (drag?.kind === 'thread') suppressedThread = drag.id
  stopReleaseWatch?.(); stopReleaseWatch = undefined
  pending = null; stopSelection?.(); stopSelection = undefined; publish(null)
}
onEnvironmentChange(() => { cancel(); suppressedThread = null; bounds.clear() })

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
    {split && <PaneHeaderOrNone id={id} />}
    <LeafBody id={id} focused={focused}><LeafContent id={id} split={split}>{children}</LeafContent></LeafBody>
    {split && focused && <div style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, borderWidth: 1, borderColor: alpha(t.v('--color-border-focus'), .28), pointerEvents: 'none' }} />}
  </div></PaneProvider>
}
/** Hosts the thread content. The Environment panel docks at its top-right and insets the content, like `Thread.tsx` (`ENVIRONMENT_DOCKED_CONTENT_INSET_PX`). */
function LeafBody({ id, focused, children }: { id: string; focused: boolean; children: ReactNode }) {
  const renderer = useGpuixRequired()
  const [node, ref] = useState<PublicInstance | null>(null)
  const panel = useEnvironmentPanel()
  const selected = useApp(s => s.selectedId)
  const docked = focused && !!panel && !panel.leaving && panel.threadId === selected
  useEffect(() => {
    if (!node || !focused) return
    const stop = observeElementBounds(renderer, node.id, event => { if (event.rect) setEnvironmentDock({ x: event.rect.x, y: event.rect.y, width: event.rect.width, height: event.rect.height }) })
    return stop
  }, [renderer, node, focused, id])
  return <div ref={ref} style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0, position: 'relative', paddingRight: docked ? DOCKED_INSET : 0 }}>{children}</div>
}
function LeafContent({ id, split, children }: { id: string; split: boolean; children: ReactNode }) {
  const selected = useApp(s => s.selectedId)
  const threads = useApp(s => s.threads)
  const [draft, showDraft] = useState(false)
  const t = useTheme()
  if (!split || selected || draft) return children
  const openIds = new Set(collectThreadPanes(getSplitRoot()).map(p => p.threadId))
  const recent = threads.filter(thread => !thread.subagent && !thread.delegation && thread.status !== 'archived' && !openIds.has(thread.id)).slice(0, 6)
  return <div testId={`pane-empty-${id}`} style={{ display: 'flex', flexGrow: 1, minHeight: 0, alignItems: 'center', justifyContent: 'center', paddingLeft: 24, paddingRight: 24, paddingTop: 40, paddingBottom: 40 }}><div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%', maxWidth: 288 }}>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: 8, marginBottom: 12, backgroundColor: t.buttonSecondary }}><Icon source={N.columns} size={16} color={t.textSecondary} /></div>
    <Label color={t.text} size={15} weight={500} lineHeight={18}>Start a conversation</Label>
    <div style={{ display: 'flex', maxWidth: 216, marginTop: 4, justifyContent: 'center' }}><Para color={t.textSecondary} size={13} lineHeight={19} style={{ textAlign: 'center' }}>Start a new thread, choose a recent one, or drag one here.</Para></div>
    <PaneButton testId={`pane-new-${id}`} tone="primary" top={16} onClick={() => { focusPane(id); showDraft(true) }}>New thread</PaneButton>
    {recent.length > 0 && <div style={{ display: 'flex', flexDirection: 'column', gap: 2, width: '100%', marginTop: 16 }}>
      {recent.map(thread => <PaneButton key={thread.id} testId={`pane-recent-${id}-${thread.id}`} tone="ghost" mark={thread.provider.kind} onClick={() => { focusPane(id); void selectPaneThread(id, thread.id) }}>{thread.title || 'Untitled'}</PaneButton>)}
    </div>}
    <PaneButton tone="outline" top={16} icon={N.x} onClick={() => closePane(id)}>Close pane</PaneButton>
  </div></div>
}
/** Kit buttons of the empty pane: default `sm` (28px), ghost `sm` rows with a provider mark, `chrome-outline` `xs`. */
function PaneButton({ children, tone, onClick, testId, top = 0, icon, mark }: { children: string; tone: 'primary' | 'ghost' | 'outline'; onClick: () => void; testId?: string; top?: number; icon?: string; mark?: string }) {
  const t = useTheme()
  const row = tone === 'ghost'
  return <div testId={testId} role="button" tabIndex={0} onClick={onClick} onKeyDown={e => { if (e.key === 'enter' || e.key === 'space') onClick() }}
    style={{ display: 'flex', alignItems: 'center', justifyContent: row ? 'flex-start' : 'center', gap: 6, height: tone === 'outline' ? 26 : 28, width: row ? '100%' : undefined, minWidth: 0, marginTop: top, paddingLeft: row ? 8 : tone === 'outline' ? 8 : 9, paddingRight: row ? 8 : tone === 'outline' ? 8 : 9, borderRadius: 8, borderWidth: 1, borderColor: tone === 'outline' ? t.border : 'rgba(0, 0, 0, 0)', backgroundColor: tone === 'primary' ? t.buttonPrimary : undefined, cursor: 'pointer', hover: tone === 'primary' ? { opacity: 0.9 } : { backgroundColor: t.buttonSecondaryHover } }}>
    {mark && <ProviderMark kind={mark} size={14} />}
    {icon && <Icon source={icon} size={14} color={t.text} />}
    <Label color={tone === 'primary' ? t.buttonPrimaryText : t.text} size={tone === 'outline' ? 13 : 14} weight={row ? 400 : 500} lineHeight={16} truncate>{children}</Label>
  </div>
}
function PaneHeaderOrNone({ id }: { id: string }) {
  // An empty pane has no header: the empty state carries its own actions.
  const selected = useApp(s => s.selectedId)
  return selected ? <PaneHeader id={id} /> : null
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

export function finishSplitDrag(e?: EventPayload) {
  // Re-evaluate at release, not the last move (including releases off target).
  if (e && e.button !== 0) return
  if (e) moveSplitDrag(e)
  const current = drag
  if (!current) { cancel(); return }
  const target = current?.kind === 'thread' ? current.target : undefined
    if (current.kind === 'thread' && target) {
      if (!getPane(target.id)?.selectedId) { focusPane(target.id); void selectPaneThread(target.id, current.id) }
      else { const { direction, side } = splitForZone(target.zone); splitPane(target.id, direction, current.id, side) }
    }
    cancel()

}
export function SplitDragLayer() {
  const renderer = useGpuixRequired()
  const [anchor, setAnchor] = useState<PublicInstance | null>(null)
  const [originY, setOriginY] = useState(0)
  useEffect(() => anchor ? observeElementBounds(renderer, anchor.id, e => setOriginY(e.rect?.y ?? 0)) : undefined, [anchor, renderer])
  const current = useDrag(), t = useTheme()
  useEffect(() => addWindowKeyHandler(e => { if (e.key === 'escape' && (drag || pending)) { cancel(); return true } }), [])
  const target = current?.kind === 'thread' ? current.target : undefined
  const rect = target ? bounds.get(target.id) : undefined
  const whole = target && !getPane(target.id)?.selectedId
  const zone = target?.zone
  return <> <div ref={setAnchor} style={{ position: 'absolute', left: 0, top: 0, width: 0, height: 0, pointerEvents: 'none' }} />{current && <div key={current.kind} testId="split-drag-layer" onMouseEnter={moveSplitDrag} onMouseMove={moveSplitDrag} onMouseUp={finishSplitDrag} style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', pointerEvents: 'auto', userSelect: 'none', cursor: current.kind === 'resize' ? current.horizontal ? 'col-resize' : 'row-resize' : 'grabbing' }}>
  </div>}
    <AnimatePresence>{rect && zone && <motion.div key={`${target!.id}-${zone}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: REDUCED_MOTION ? 0 : .15, ease: [.22, 1, .36, 1] }} style={{ position: 'absolute', left: rect.x, top: rect.y - originY, width: rect.width, height: rect.height, pointerEvents: 'none', backgroundColor: alpha(t.surface, .22) }}>
      {!whole && <div style={{ position: 'absolute', ...(zone === 'left' || zone === 'right' ? { left: rect.width / 2, top: 8, bottom: 8, width: 1 } : { top: rect.height / 2, left: 8, right: 8, height: 1 }), backgroundColor: alpha(t.v('--color-border-focus'), .58), pointerEvents: 'none' }} />}
      <div backdrop={BACKDROP_ALLOWED ? BACKDROP.drop : undefined} testId="pane-drop-highlight" style={{ position: 'absolute', left: !whole && zone === 'right' ? rect.width / 2 + 4 : 8, top: !whole && zone === 'bottom' ? rect.height / 2 + 4 : 8, width: rect.width / (!whole && (zone === 'left' || zone === 'right') ? 2 : 1) - (!whole && (zone === 'left' || zone === 'right') ? 12 : 16), height: rect.height / (!whole && (zone === 'top' || zone === 'bottom') ? 2 : 1) - (!whole && (zone === 'top' || zone === 'bottom') ? 12 : 16), borderRadius: 10, borderWidth: 1, borderColor: alpha(t.v('--color-border-focus'), .64), backgroundColor: alpha(t.surface, .38), boxShadow: { offsetX: 0, offsetY: 12, blurRadius: 36, spreadRadius: 0, color: 'rgba(0,0,0,.12)' }, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
        {/* GPUIX chooses backgroundColor over background; paint the gradient separately. */}
        <div style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', borderRadius: 10, pointerEvents: 'none', background: { type: 'linear-gradient', angle: 180, stops: [{ color: alpha(t.v('--color-background-accent'), .18), position: 0 }, { color: alpha(t.v('--color-background-accent'), .08), position: 1 }] } }} />
        <div backdrop={BACKDROP_ALLOWED ? BACKDROP.dropLabel : undefined} style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, borderRadius: 8, borderWidth: 1, borderColor: alpha(t.v('--color-border-focus'), .42), backgroundColor: alpha(t.popover, .88), pointerEvents: 'none' }}><Icon source={whole || zone === 'left' || zone === 'right' ? N.splitRight : N.splitDown} size={16} color={t.text} /><Label color={t.text} size={12} weight={500}>{whole ? 'Open here' : ({ left: 'Split left', right: 'Split right', top: 'Split above', bottom: 'Split below' })[zone]}</Label></div>
      </div>
    </motion.div>}</AnimatePresence>
  {current?.kind === 'thread' && <div style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
    {current.kind === 'thread' && <div style={{ position: 'absolute', display: 'flex', alignItems: 'center', gap: 8, left: current.x - (current.ghost?.offX ?? -12), top: current.y - originY - (current.ghost?.offY ?? -12), width: current.ghost?.width ?? 240, height: current.ghost?.height ?? 29, paddingLeft: 10, paddingRight: 10, borderRadius: 10, backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, boxShadow: { offsetX: 0, offsetY: 8, blurRadius: 24, spreadRadius: 0, color: 'rgba(0, 0, 0, 0.2)' }, pointerEvents: 'none' }}>{current.ghost ? <><ProviderMark kind={current.ghost.kind} size={14} /><Label color={t.text} size={14} truncate>{current.ghost.title}</Label></> : <Label color={t.text} size={12}>Move conversation</Label>}</div>}
  </div>}
  </>
}
