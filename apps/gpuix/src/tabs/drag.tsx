// Dragging a tab (ADE-54): along its strip to reorder, onto another strip of the same thread to move it there, or onto a pane
// edge to split it into a new group (the thread-drag drop zones and overlay, `split/Workspace.tsx`). Tabs never cross threads:
// over another thread's group nothing is offered. A drag makes a preview tab permanent.
//
// GPUIX sends mouse moves only to the element under the pointer, so the press is tracked on the tab itself until it moves 6 px
// or leaves the tab; from then a window-wide capture layer (`TabsDragLayer`, mounted once in App) follows it. Escape cancels.
import { useEffect, useState, useSyncExternalStore } from 'react'
import { useGpuixRequired, type EventPayload, type PublicInstance } from '@gpuix/react'
import { addWindowKeyHandler } from '../nav/keys.ts'
import { observeElementBounds, type LayoutRect } from '../native/layout.ts'
import type { TabsItem } from '../kit/Tabs.tsx'
import { Icon } from '../icons.tsx'
import { Label, ProviderMark, useTheme } from '../ui.tsx'
import { canSplitPane, getGroup, getSplitRoot } from '../split/store.ts'
import { dropZoneAt, splitForZone, type DropZone } from '../split/geometry.ts'
import { DropOverlay, paneRects } from '../split/Workspace.tsx'
import { moveTabToGroup, reorderTab, splitTab, keepTab } from './open.ts'

type Target = { kind: 'strip'; leafId: string; index: number } | { kind: 'edge'; leafId: string; zone: DropZone }
interface Drag { leafId: string; key: string; item: TabsItem; size: 'md' | 'sm'; x: number; y: number; target?: Target; refused?: boolean }
let pending: { leafId: string; key: string; item: TabsItem; size: 'md' | 'sm'; x: number; y: number } | null = null
let drag: Drag | null = null
const listeners = new Set<() => void>()
const publish = (next: Drag | null) => { drag = next; for (const l of listeners) l() }
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
export const useTabsDragging = () => useSyncExternalStore(subscribe, () => drag !== null)
/** The insertion index a drag would drop at in this leaf's strip, or null. */
export const useTabsDrop = (leafId: string) => useSyncExternalStore(subscribe, () => drag?.target?.kind === 'strip' && drag.target.leafId === leafId ? drag.target.index : null)

/** Strips register their tab nodes so a drag can find insertion points (window rects read at move time). */
const strips = new Map<string, { strip: PublicInstance | null; tabs: Map<string, PublicInstance> }>()
export function stripRegistry(leafId: string) {
  let entry = strips.get(leafId)
  if (!entry) strips.set(leafId, entry = { strip: null, tabs: new Map() })
  return entry
}

export function beginTabsDrag(leafId: string, key: string, item: TabsItem, event: EventPayload, _rect: LayoutRect | null, size: 'md' | 'sm') {
  if (event.button !== 0 || event.x == null || event.y == null) return
  pending = { leafId, key, item, size, x: event.x, y: event.y }
}
/** Moves over the pressed tab; leaving it, or 6 px of travel, starts the drag. */
export function trackTabsPress(event: EventPayload, left = false) {
  if (!pending || drag) return
  if (event.pressedButton !== 0 && !left) { pending = null; return }
  if (!left && Math.hypot((event.x ?? pending.x) - pending.x, (event.y ?? pending.y) - pending.y) < 6) return
  const start = pending
  pending = null
  publish({ ...start, x: event.x ?? start.x, y: event.y ?? start.y })
}
export function endTabsPress() { pending = null }

function targetAt(renderer: object, x: number, y: number): { target?: Target; refused?: boolean } {
  if (!drag) return {}
  const r = renderer as { getElementBounds?: (id: number) => LayoutRect | null }
  const threadId = getGroup(drag.leafId).threadId
  for (const [leafId, entry] of strips) {
    const box = entry.strip && r.getElementBounds?.(entry.strip.id)
    if (!box || x < box.x || x > box.x + box.width || y < box.y - 4 || y > box.y + box.height + 4) continue
    if (getGroup(leafId).threadId !== threadId) return { refused: true }
    const keys = getGroup(leafId).tabs.map((tab) => tab)
    let index = 0
    for (const [key, node] of entry.tabs) {
      const tab = r.getElementBounds?.(node.id)
      if (!tab) continue
      const at = getGroup(leafId).tabs.findIndex((t) => tabKeyOf(t) === key)
      if (at >= 0 && x > tab.x + tab.width / 2) index = Math.max(index, at + 1)
    }
    return { target: { kind: 'strip', leafId, index: Math.min(index, keys.length) } }
  }
  for (const [leafId, rect] of paneRects()) {
    const zone = dropZoneAt({ left: rect.x, top: rect.y, width: rect.width, height: rect.height }, x, y, (direction) => canSplitPane(getSplitRoot(), leafId, direction))
    if (!zone) continue
    if (getGroup(leafId).threadId !== threadId) return { refused: true }
    if (leafId === drag.leafId && getGroup(leafId).tabs.length < 2) return {}
    return { target: { kind: 'edge', leafId, zone } }
  }
  return {}
}
import { tabKey as tabKeyOf } from './model.ts'

function finish(commit: boolean) {
  const current = drag
  pending = null
  publish(null)
  if (!commit || !current?.target) return
  const { leafId, key } = current
  const target = current.target
  keepTab(leafId, key)
  if (target.kind === 'strip') {
    if (target.leafId === leafId) {
      const from = getGroup(leafId).tabs.findIndex((t) => tabKeyOf(t) === key)
      reorderTab(leafId, key, from >= 0 && from < target.index ? target.index - 1 : target.index)
    } else moveTabToGroup(leafId, key, target.leafId, target.index)
  } else {
    const { direction, side } = splitForZone(target.zone)
    splitTab(leafId, key, direction, side, target.leafId)
  }
}

/** The capture layer and the held tab, mounted once at the window root (App). */
export function TabsDragLayer() {
  const renderer = useGpuixRequired()
  const t = useTheme()
  const current = useSyncExternalStore(subscribe, () => drag)
  const [anchor, setAnchor] = useState<PublicInstance | null>(null)
  const [origin, setOrigin] = useState(0)
  useEffect(() => anchor ? observeElementBounds(renderer, anchor.id, (e) => setOrigin(e.rect?.y ?? 0)) : undefined, [anchor, renderer])
  useEffect(() => addWindowKeyHandler((e) => { if (e.key === 'escape' && (drag || pending)) { finish(false); return true } }), [])
  const move = (e: EventPayload) => {
    if (!drag || e.x == null || e.y == null) return
    if (e.eventType === 'mouseMove' && e.pressedButton !== 0) { finish(true); return }
    const next = targetAt(renderer, e.x, e.y)
    publish({ ...drag, x: e.x, y: e.y, target: next.target, refused: next.refused })
  }
  const rect = current?.target?.kind === 'edge' ? paneRects().get(current.target.leafId) : undefined
  return <>
    <div ref={setAnchor} style={{ position: 'absolute', left: 0, top: 0, width: 0, height: 0, pointerEvents: 'none' }} />
    {current && <div testId="tabs-drag-layer" onMouseMove={move} onMouseEnter={move} onMouseUp={(e) => { move(e); finish(true) }}
      style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', cursor: current.refused ? 'not-allowed' : 'grabbing' }} />}
    {current && rect && current.target?.kind === 'edge' && <DropOverlay key={`${current.target.leafId}:${current.target.zone}`} rect={{ x: rect.x, y: rect.y - origin, width: rect.width, height: rect.height }} zone={current.target.zone} whole={false} />}
    {current && <div testId="tabs-drag-ghost" style={{ position: 'absolute', left: current.x + 10, top: current.y - origin + 10, display: 'flex', alignItems: 'center', gap: 6, height: current.size === 'md' ? 28 : 24, paddingLeft: 8, paddingRight: 10, borderRadius: 8, backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, boxShadow: { offsetX: 0, offsetY: 8, blurRadius: 24, spreadRadius: 0, color: 'rgba(0, 0, 0, 0.2)' }, pointerEvents: 'none', opacity: current.refused ? 0.6 : 1 }}>
      {current.item.mark ? <ProviderMark kind={current.item.mark} size={14} /> : current.item.icon ? <Icon source={current.item.icon} size={14} color={t.textSecondary} /> : null}
      <Label color={t.text} size={current.size === 'md' ? 13 : 12} weight={500}>{current.item.label}</Label>
    </div>}
  </>
}
