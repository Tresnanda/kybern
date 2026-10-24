// The spaces section of the app rail (`docs/specs/spaces.md` §7.5): a divider, one 32 px tile per
// space (two or more), and a "+" tile that opens the editor. The active space wears a pill on
// the leading edge. Switching never animates.
import { useGpuixRequired, type PublicInstance } from '@gpuix/react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SPACE_COPY, SPACE_LIMIT, canDeleteSpace } from '../../../../packages/kybern-client/src/spaces.ts'
import type { Project, Space, Thread } from '../../../../packages/kybern-client/src/types.ts'
import { Icon } from '../icons.tsx'
import { ATTENTION_RANK, attentionKind, type AttentionKind } from '../../../../packages/kybern-client/src/threadAttention.ts'
import { N } from '../nav/glyphs.ts'
import { ContextMenu, MenuItem, MenuLabel, MenuSeparator, Tip } from '../nav/overlay.tsx'
import { useNav, type NavState } from '../nav/store.ts'
import { observeElementBounds } from '../native/layout.ts'
import { pressTransform } from '../motion/press.ts'
import { DURATION, EASE } from '../motion/kit.tsx'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { useApp } from '../state.ts'
import { over } from '../theme.ts'
import type { Theme } from '../theme.ts'
import { ink, REDUCED_MOTION, useMaterial, useTheme } from '../ui.tsx'
import { activateSpace, useCurrentSpaceId } from './current.ts'
import { registerSpaceScroller, registerSpaceTarget, useSpaceDrag } from './drop.ts'
import { SpaceEditor } from './SpaceEditor.tsx'
import { DeleteSpace } from './DeleteSpace.tsx'
import { SpaceLogo } from './SpaceLogo.tsx'
import { moveSpace, useSpaces } from './store.ts'
import { askDeleteSpace, closeSpaceMenu, getSpaceUi, openSpaceEditor, openSpaceMenu, takeSpaceCreated, useSpaceUi } from './ui.ts'

const RAIL = 52
const ROW = 40
const TILE = 32

const railIdle = (t: Theme) => ink(t, 0.62)

/** Whether the section shows at all: the daemon has spaces (the divider and "+" appear with one). */
export function useRailSpacesVisible(): boolean {
  return useSpaces((s) => s.supported === true)
}

type AttentionInputs = [threads: readonly Thread[], projects: readonly Project[], unread: NavState['unread'], dismissals: NavState['attentionDismissals']]
let attentionMemo: { inputs: AttentionInputs; key: string } | null = null
/** Each space's attention as `space:kind|…`, recomputed only when its inputs change. */
function attentionKey(...inputs: AttentionInputs): string {
  if (attentionMemo && inputs.every((value, index) => value === attentionMemo!.inputs[index])) return attentionMemo.key
  const [threads, projects, unread, attentionDismissals] = inputs
  const spaceOf = new Map(projects.map((project) => [project.id, project.space_id ?? null]))
  const out: Record<string, AttentionKind> = {}
  for (const thread of threads) {
    const space = spaceOf.get(thread.project_id)
    if (!space) continue
    const kind = attentionKind(thread, { unread, attentionDismissals })
    if (kind && (out[space] === undefined || ATTENTION_RANK[kind] < ATTENTION_RANK[out[space]!])) out[space] = kind
  }
  attentionMemo = { inputs, key: Object.entries(out).map(([space, kind]) => `${space}:${kind}`).join('|') }
  return attentionMemo.key
}

/**
 * Another space's most urgent attention: a blocked or failed thread, else an unread finished one. Selected as a string, so
 * thread updates that change no space's attention do not re-render the rail section (§7.5).
 */
function useSpaceAttention(): Record<string, AttentionKind> {
  const unread = useNav((s) => s.unread)
  const attentionDismissals = useNav((s) => s.attentionDismissals)
  const key = useApp((s) => attentionKey(s.threads, s.projects, unread, attentionDismissals))
  return useMemo(() => Object.fromEntries(key ? key.split('|').map((entry) => entry.split(':') as [string, AttentionKind]) : []), [key])
}

export function RailSpaces() {
  const t = useTheme()
  const renderer = useGpuixRequired()
  const spaces = useSpaces((s) => s.spaces)
  const supported = useSpaces((s) => s.supported)
  const current = useCurrentSpaceId()
  const attention = useSpaceAttention()
  const [scroller, setScroller] = useState<PublicInstance | null>(null)
  const [edges, setEdges] = useState({ top: false, bottom: false })

  // The rail's only scroller: hairlines say there is more above or below.
  const measure = () => {
    if (!scroller) return
    const offset = renderer.getScrollOffset?.(scroller.id)
    const bounds = renderer.getElementBounds?.(scroller.id)
    if (!offset || !bounds) return
    const content = (spaces.length >= 2 ? spaces.length * ROW : 0) + TILE + 8
    const scrolled = -offset[1]
    const next = { top: scrolled > 0.5, bottom: scrolled + bounds.height < content - 0.5 }
    setEdges((previous) => (previous.top === next.top && previous.bottom === next.bottom ? previous : next))
  }
  useEffect(() => {
    if (!scroller) return
    measure()
    return observeElementBounds(renderer, scroller.id, () => measure())
  }, [renderer, scroller, spaces.length])

  // A switch scrolls the active tile into view, instantly.
  const activeRow = useRef<PublicInstance | null>(null)
  const activeRef = useCallback((node: PublicInstance | null) => { activeRow.current = node }, [])
  useEffect(() => { if (activeRow.current) renderer.scrollIntoView?.(activeRow.current.id) }, [current, renderer])

  if (supported !== true) return null
  const list = spaces.length >= 2
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: RAIL, flexGrow: 1, minHeight: 0 }}>
      <div style={{ width: 20, height: 1, flexShrink: 0, marginTop: 14, borderRadius: 0.5, backgroundColor: ink(t, 0.1) }} />
      <div style={{ width: 20, height: 1, flexShrink: 0, marginTop: 7, backgroundColor: edges.top ? ink(t, 0.07) : 'transparent' }} />
      <div ref={(node) => { setScroller(node); registerSpaceScroller(node) }} testId="rail-spaces" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: RAIL, flexShrink: 1, minHeight: 0, overflow: 'scroll' }}>
        {list && spaces.map((space, index) => (
          <SpaceRow
            key={space.id}
            space={space}
            index={index}
            count={spaces.length}
            active={space.id === current}
            dot={space.id === current ? undefined : attention[space.id]}
            rowRef={space.id === current ? activeRef : undefined}
          />
        ))}
        <NewSpaceTile full={spaces.length >= SPACE_LIMIT} only={list ? undefined : spaces[0]} />
      </div>
      <div style={{ width: 20, height: 1, flexShrink: 0, backgroundColor: edges.bottom ? ink(t, 0.07) : 'transparent' }} />
      <SpaceMenu spaces={spaces} />
      <DeleteSpace />
    </div>
  )
}

/** Tooltip shortcut: ⌃1–⌃8 for the first eight and ⌃9 for the last. */
function shortcutFor(index: number, count: number): string[] | undefined {
  if (index === count - 1 && count > 8) return ['⌃', '9']
  return index < 8 ? ['⌃', String(index + 1)] : undefined
}

const SpaceRow = memo(function SpaceRow({ space, index, count, active, dot, rowRef }: {
  space: Space
  index: number
  count: number
  active: boolean
  dot: AttentionKind | undefined
  rowRef?: (node: PublicInstance | null) => void
}) {
  const t = useTheme()
  const fills = useMaterial()
  const [hover, setHover] = useState(false)
  const editing = useSpaceUi((s) => s.editor?.mode === 'edit' && s.editor.anchor === space.id)
  const dragActive = useSpaceDrag((s) => s.active)
  const target = useSpaceDrag((s) => s.target === space.id)
  const [pop] = useState(() => takeSpaceCreated(space.id))
  const ring = dragActive && !active
  return (
    // The editor is a sibling of the row, so a press inside it never reaches the row's click.
    <div style={{ position: 'relative', width: RAIL, height: ROW, flexShrink: 0 }}>
    <Tip label={target ? SPACE_COPY.dropTooltip(space.name) : space.name} shortcut={target ? undefined : shortcutFor(index, count)} side="right" sideOffset={6} size={ROW} open={target ? true : undefined}>
      <div
        ref={(node) => { registerSpaceTarget(space.id, node); rowRef?.(node) }}
        testId={`rail-space-${space.id}`}
        role="button"
        aria-label={active ? `${space.name} space, current` : `${space.name} space`}
        windowDrag={false}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onClick={() => activateSpace(space.id, 'pointer')}
        onAuxClick={(event) => { if (event.isRightClick || event.button === 2) openSpaceMenu(space.id, { x: event.x ?? 0, y: event.y ?? 0 }) }}
        style={{ position: 'relative', width: RAIL, height: ROW, flexShrink: 0, cursor: 'pointer' }}
      >
        {active && <div testId={`rail-space-pill-${space.id}`} style={{ position: 'absolute', left: 0, top: 10, width: 3, height: 20, borderRadius: 1.5, backgroundColor: t.text, pointerEvents: 'none' }} />}
        {!active && hover && !dragActive && <div style={{ position: 'absolute', left: 0, top: 16, width: 3, height: 8, borderRadius: 1.5, backgroundColor: ink(t, 0.5), pointerEvents: 'none' }} />}
        <div
          paintTransform={pop && PATCHED_NATIVE && !REDUCED_MOTION ? { initial: { opacity: 0, scale: 0.9 }, animate: { opacity: 1, scale: 1 }, transition: { duration: 0.15, ease: [...EASE.out] } } : pressTransform()}
          style={{ position: 'absolute', left: 10, top: 4, width: TILE, height: TILE }}
        >
          <SpaceLogo space={space} size={32} />
        </div>
        {ring && (
          <div style={{ position: 'absolute', left: 8, top: 2, width: 36, height: 36, borderRadius: 11, borderWidth: target ? 2 : 1, borderColor: target ? t.link : ink(t, 0.18), pointerEvents: 'none' }} />
        )}
        {dot && <div testId={`rail-space-dot-${space.id}`} style={{ position: 'absolute', right: 7, top: 1, width: 7, height: 7, borderRadius: 3.5, backgroundColor: dot === 'done' ? t.text : t.taskReview, borderWidth: 2, borderColor: over(fills.frame, t.variant === 'light' ? '#ffffff' : '#000000'), pointerEvents: 'none' }} />}
      </div>
    </Tip>
    {editing && <SpaceEditor mode="edit" space={space} />}
    </div>
  )
})

/** `only`: the sole space, whose tile is hidden. Its editor opens here (from the palette), beside the "+" tile. */
function NewSpaceTile({ full, only }: { full: boolean; only?: Space }) {
  const t = useTheme()
  const [hover, setHover] = useState(false)
  const open = useSpaceUi((s) => s.editor?.mode === 'create' && s.editor.anchor === 'plus')
  const still = useSpaceUi((s) => !!s.editor?.still)
  const editingOnly = useSpaceUi((s) => !!only && s.editor?.mode === 'edit' && s.editor.anchor === only.id)
  return (
    <div style={{ position: 'relative', width: RAIL, height: ROW, flexShrink: 0 }}>
    <Tip label={full ? SPACE_COPY.limitTooltip : SPACE_COPY.newSpaceTooltip} side="right" sideOffset={6} size={ROW}>
      <div
        testId="rail-space-new"
        role="button"
        aria-label={SPACE_COPY.newSpaceTooltip}
        windowDrag={false}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onClick={() => { if (!full) openSpaceEditor({ anchor: 'plus', mode: 'create' }) }}
        style={{ position: 'relative', width: RAIL, height: ROW, flexShrink: 0, cursor: full ? 'default' : 'pointer', opacity: full ? 0.4 : 1 }}
      >
        <div
          paintTransform={full ? undefined : pressTransform()}
          style={{ position: 'absolute', left: 10, top: 4, width: TILE, height: TILE, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 9, backgroundColor: ink(t, hover && !full ? 0.1 : 0.06) }}
        >
          <Icon source={N.plus} size={16} color={hover && !full ? t.text : railIdle(t)} style={{ pointerEvents: 'none' }} />
        </div>
      </div>
    </Tip>
    {open && <SpaceEditor mode="create" still={still} />}
    {editingOnly && only && <SpaceEditor mode="edit" space={only} still={still} />}
    </div>
  )
}

/** The tile context menu (§7.7), at the pointer. */
function SpaceMenu({ spaces }: { spaces: Space[] }) {
  const menu = useSpaceUi((s) => s.menu)
  if (!menu) return null
  const index = spaces.findIndex((space) => space.id === menu.spaceId)
  if (index < 0) return null
  const space = spaces[index]!
  return (
    <ContextMenu at={menu.at} onClose={closeSpaceMenu} testId="space-menu">
      <MenuItem id="edit" testId="space-menu-edit" icon={N.pencil} label={SPACE_COPY.menuEdit} onSelect={() => openSpaceEditor({ anchor: space.id, mode: 'edit' })} />
      <MenuSeparator />
      <MenuItem id="up" testId="space-menu-up" icon={N.arrowUp} label={SPACE_COPY.menuMoveUp} disabled={index === 0} onSelect={() => void moveSpace(space.id, -1).catch(() => {})} />
      <MenuItem id="down" testId="space-menu-down" icon={N.arrowDown} label={SPACE_COPY.menuMoveDown} disabled={index === spaces.length - 1} onSelect={() => void moveSpace(space.id, 1).catch(() => {})} />
      <MenuSeparator />
      <MenuItem id="delete" testId="space-menu-delete" icon={N.trash} label={SPACE_COPY.menuDelete} destructive={canDeleteSpace(space)} disabled={!canDeleteSpace(space)} onSelect={() => askDeleteSpace(space.id)} />
      {!canDeleteSpace(space) && <MenuLabel>{SPACE_COPY.defaultCantDelete}</MenuLabel>}
    </ContextMenu>
  )
}

export { getSpaceUi }
