// The one tab strip (ADE-55 §2.7, Direction C): the in-thread strip, the dock, the PR detail and the model picker.
//
// A tab is 28 (sm 24) high: 8 (sm 7) padding, a 14 glyph or provider mark, 6 gap, a 13/500 (sm 12/500) label, then a 16
// square ✕ (glyph 11, radius 5) that shows on the active and the hovered tab and keeps its room otherwise. The active tab of
// a focused strip has no fill: a 2 px accent underline, (width − 16) wide, sits on the strip's bottom edge. In an unfocused
// strip (another split group has focus) it is dimmed: the underline turns to ink and the label to secondary text, so the
// focused group is the one accent line on screen. A lone tab is marked only with `markSingle` (a group of a split). Hover is the 5% fill in an
// 8 radius box. Labels truncate between 96 and 200; the tooltip names the whole thing. A preview tab's label is italic.
//
// Overflow scrolls sideways with a 16 px fade at the cut edges and a » menu of every tab. Motion: a new tab fades into
// view (opacity and scale 0.97, 150 ms, `EASE.out`), a closed one shrinks away (120 ms); switching is instant.
// Reduce Motion: opacity only, 90 ms.
import { ArrowRightDoubleIcon, Cancel01Icon } from '@hugeicons/core-free-icons'
import { motion, useGpuix, type EventPayload, type PublicInstance } from '@gpuix/react'
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { glyph, Icon } from '../icons.tsx'
import { Menu, MenuItem, Tip } from '../nav/overlay.tsx'
import { observeElementBounds, type LayoutRect } from '../native/layout.ts'
import { EDGE_FADE, PATCHED_NATIVE } from '../native/local-build.ts'
import { EASE } from '../motion/tokens.ts'
import { pressTransform } from '../motion/press.ts'
import { markdownTheme } from '../transcript/kit.tsx'
import type { Theme } from '../theme.ts'
import { ink, Label, ProviderMark, REDUCED_MOTION, useTheme } from '../ui.tsx'

const OVERFLOW = glyph(ArrowRightDoubleIcon)
const X = glyph(Cancel01Icon)

export interface TabsItem {
  key: string
  label: string
  /** A glyph source (`Icon`), a provider mark, or a node. At most one. */
  icon?: string
  mark?: string
  iconNode?: ReactNode
  /** Italic label: the single-click tab that the next single click replaces. */
  preview?: boolean
  /** No ✕ (the chat tab). */
  pinned?: boolean
  /** A 6 px dot in place of the ✕ until hover (a running terminal, an unsaved note). */
  dirty?: boolean
  /** Shown but not selectable (an account that needs signing in); the label dims. */
  disabled?: boolean
  /** Glyph only; `label` stays the accessible name and the » menu entry. */
  iconOnly?: boolean
  /** A trailing count or badge after the label (`text3`), or a node (coloured diff stats). */
  detail?: string
  extra?: ReactNode
  tooltip?: string
  testId?: string
  /** Defaults to `<testId>-close`. */
  closeTestId?: string
}

export interface TabsProps {
  items: TabsItem[]
  active: string | null
  size?: 'md' | 'sm'
  /** False when another split group has focus: the active tab's underline and label are dimmed. */
  focused?: boolean
  /** Underline the active tab even when it is the only one (each group of a split marks its active tab). */
  markSingle?: boolean
  onSelect: (key: string) => void
  onClose?: (key: string) => void
  onDoubleClick?: (key: string) => void
  /** A press on a tab (drag starts here); `rect` is the tab's window rect. */
  onTabMouseDown?: (key: string, event: EventPayload, rect: LayoutRect | null) => void
  onTabMouseUp?: (key: string, event: EventPayload) => void
  /** Moves over a pressed tab, and leaving it (`left`): a drag starts from these. */
  onTabMouseMove?: (key: string, event: EventPayload, left: boolean) => void
  /** Tab nodes and the strip's root node, for a drag to read window rects. */
  registerTab?: (key: string, node: PublicInstance | null) => void
  stripRef?: (node: PublicInstance | null) => void
  /** Space from a tab's bottom to the strip's bottom edge, where the underline sits (46 px header: 9; 32 px strip: 4). */
  underlineGap?: number
  /** Draw a 1 × 16 divider after this tab (the pinned chat). */
  dividerAfter?: string
  /** A 1 × 16 bar between neighbouring tabs, hidden beside the active and the hovered tab (the thread strip). */
  separators?: boolean
  /** Scroll and the » menu (on by default). Text-only strips that always fit pass false. */
  overflow?: boolean
  /** Tabs narrower than 96 (text-only strips). */
  minWidth?: number
  /** A drag in progress: the insertion line before this index. */
  dropIndex?: number | null
  /** Controls after the tabs, inside the strip (a + menu). */
  trailing?: ReactNode
  testId?: string
  /** Space between tabs (2; the dock's reorder geometry uses 4). */
  gap?: number
  /** Wraps each live tab (the dock's reorder slot). */
  wrapTab?: (key: string, tab: ReactNode) => ReactNode
  /** Animate tabs that appear and leave after the first render (off for strips rebuilt per keystroke). */
  animate?: boolean
  style?: object
}

/** Spec §2.7 / §5: geometry and Direction C colours. */
export function tabTokens(t: Theme) {
  const dark = t.variant === 'dark'
  return {
    accent: dark ? 'rgba(51, 134, 214, 1)' : 'rgba(1, 105, 204, 1)',
    hover: ink(t, 0.05),
    dimLine: ink(t, dark ? 0.26 : 0.22),
    closeHover: ink(t, 0.1),
    divider: ink(t, dark ? 0.1 : 0.12),
  }
}

const GEOMETRY = {
  md: { height: 28, pad: 8, text: 13, glyph: 14 },
  sm: { height: 24, pad: 7, text: 12, glyph: 14 },
} as const
const MAX = 200, CLOSE = 16
/** A pinned tab (the chat) is up to 320 wide; one with an `extra` (the title bar's machine pill) gets room for it on top. */
const pinnedMax = (item: { extra?: unknown }) => 320 + (item.extra ? 120 : 0)

/** Italic is a Markdown emphasis in GPUIX (text styles have no `fontStyle`): one short line, pre-truncated to the tab's room. */
const italicThemes = new WeakMap<Theme, Map<string, object>>()
function italicTheme(t: Theme, size: number, color: string) {
  let themes = italicThemes.get(t)
  if (!themes) italicThemes.set(t, themes = new Map())
  const key = `${size}:${color}`
  let theme = themes.get(key)
  if (!theme) {
    const base = markdownTheme(t)
    theme = { ...base, text: color, metrics: { ...base.metrics, mdTextSize: size, mdLineHeight: size + 3, mdBlockGap: 0 } }
    themes.set(key, theme)
  }
  return theme
}
const escapeMarkdown = (text: string) => text.replace(/([\\`*_[\]<>#|~!])/g, '\\$1')
/** About 6.6 px per character at 13 px SF Pro: keep the italic label inside the 200 px tab (the tooltip has the rest). */
const clipRoom = (size: number) => Math.floor((MAX - 2 * 8 - 14 - 6 - CLOSE - 6) / (size * 0.51))
function clip(label: string, size: number) {
  const room = clipRoom(size)
  return label.length > room ? `${label.slice(0, Math.max(1, room - 1))}…` : label
}
/** The trailing fade of a cut tab label. */
const LABEL_FADE = { right: 20 }

export const Tabs = memo(function Tabs(props: TabsProps) {
  const { items, active, size = 'md', focused = true, onSelect, dividerAfter, separators = false, overflow = true, trailing, testId, dropIndex = null, animate = true, style } = props
  const t = useTheme()
  const { renderer } = useGpuix()
  const scroll = useRef<PublicInstance | null>(null)
  const row = useRef<PublicInstance | null>(null)
  const nodes = useRef(new Map<string, PublicInstance>())
  const [extent, setExtent] = useState({ view: 0, content: 0, offset: 0 })
  // The hovered tab hides the separators on both of its sides, as the active tab does.
  const [hovered, setHovered] = useState<string | null>(null)
  // Tabs present at the first render appear at once; later ones grow in. Closed tabs stay for their exit.
  const seen = useRef<Set<string> | null>(null)
  const fresh = useRef(new Set<string>())
  if (seen.current === null) seen.current = new Set(items.map((item) => item.key))
  for (const item of items) if (!seen.current.has(item.key)) { seen.current.add(item.key); if (animate && PATCHED_NATIVE) fresh.current.add(item.key) }
  const [leaving, setLeaving] = useState<{ item: TabsItem; index: number; width: number }[]>([])
  const previous = useRef(items)
  if (previous.current !== items) {
    const gone = previous.current.filter((old) => !items.some((item) => item.key === old.key))
    previous.current = items
    if (gone.length && animate && PATCHED_NATIVE) {
      const exits = gone.map((item) => {
        const node = nodes.current.get(item.key)
        const width = node ? renderer?.getElementBounds?.(node.id)?.width ?? 0 : 0
        return { item, index: Math.max(0, previousIndex(item.key)), width }
      }).filter((exit) => exit.width > 0)
      if (exits.length) setLeaving((current) => [...current.filter((c) => !exits.some((e) => e.item.key === c.item.key)), ...exits])
    }
    for (const item of gone) seen.current.delete(item.key)
  }
  function previousIndex(key: string) { return [...nodes.current.keys()].indexOf(key) }
  // Content and view widths: whether the strip overflows, and so whether the fades and the » menu show.
  useEffect(() => {
    if (!renderer || !overflow || !row.current || !scroll.current) return
    const view = observeElementBounds(renderer, scroll.current.id, (e) => { if (e.rect) setExtent((x) => x.view === e.rect!.width ? x : { ...x, view: e.rect!.width }) })
    const content = observeElementBounds(renderer, row.current.id, (e) => { if (e.rect) setExtent((x) => x.content === e.rect!.width ? x : { ...x, content: e.rect!.width }) })
    return () => { view(); content() }
  }, [renderer, overflow])
  const overflowing = overflow && extent.content > extent.view + 0.5
  // Keep the active tab in view (instant: scrolling is not animated in GPUIX without a per-frame JS loop).
  useEffect(() => {
    if (!overflowing || !active || !scroll.current) return
    const node = nodes.current.get(active)
    const tab = node && renderer?.getElementBounds?.(node.id), view = renderer?.getElementBounds?.(scroll.current.id)
    if (!tab || !view) return
    const offset = renderer?.getScrollOffset?.(scroll.current.id)?.[0] ?? 0
    const left = tab.x - view.x - offset, right = left + tab.width
    const next = left < 0 ? left : right > view.width ? right - view.width : null
    if (next === null) return
    renderer?.scrollTo?.(scroll.current.id, -Math.max(0, Math.min(extent.content - view.width, next)), 0)
    setExtent((x) => ({ ...x, offset: -Math.max(0, Math.min(extent.content - view.width, next)) }))
  }, [active, overflowing, extent.content, extent.view, renderer])
  const readOffset = () => { if (scroll.current) { const offset = renderer?.getScrollOffset?.(scroll.current.id)?.[0] ?? 0; setExtent((x) => x.offset === offset ? x : { ...x, offset }) } }
  const fade = overflowing && EDGE_FADE ? { left: extent.offset < -0.5 ? 16 : 0, right: extent.content + extent.offset > extent.view + 0.5 ? 16 : 0 } : undefined
  const tok = tabTokens(t)
  const geometry = GEOMETRY[size]
  const rendered: { item: TabsItem; leaving?: number }[] = items.map((item) => ({ item }))
  for (const exit of leaving) rendered.splice(Math.min(exit.index, rendered.length), 0, { item: exit.item, leaving: exit.width })
  /** A bar on this tab's leading edge: not first, not after the pinned chat's divider, and neither side active or hovered. */
  function separatorBefore(index: number) {
    const before = rendered[index - 1], here = rendered[index]
    if (!before || !here || before.leaving !== undefined || before.item.key === dividerAfter) return false
    const lit = (key: string) => key === active || key === hovered
    return !lit(before.item.key) && !lit(here.item.key)
  }
  return (
    <div ref={props.stripRef} testId={testId} role="tablist" style={{ display: 'flex', alignItems: 'center', flexGrow: 1, flexShrink: 1, minWidth: 0, height: '100%', gap: 2, ...style }}>
      <div ref={scroll} onScroll={overflow ? readOffset : undefined} edgeFade={fade} style={{ display: 'flex', alignItems: 'center', flexShrink: 1, minWidth: 0, height: '100%', ...(overflow ? { overflowX: 'scroll', overflowY: 'hidden' } : {}) }}>
        <div ref={row} style={{ display: 'flex', alignItems: 'center', gap: props.gap ?? 2, height: '100%', flexShrink: 0, position: 'relative' }}>
          {rendered.map(({ item, leaving: width }, index) => {
            const body = <TabView
              key={item.key}
              item={item}
              index={index}
              size={size}
              active={item.key === active}
              focused={focused}
              props={props}
              tok={tok}
              geometry={geometry}
              register={(node) => { if (node) nodes.current.set(item.key, node); else nodes.current.delete(item.key); if (width === undefined) props.registerTab?.(item.key, node) }}
              drop={dropIndex === index}
              separator={separators && width === undefined && separatorBefore(index)}
              onHover={setHovered}
            />
            const divider = dividerAfter === item.key && rendered.length > 1 ? <div key={`${item.key}:divider`} style={{ width: 1, height: 16, marginLeft: 4, marginRight: 4, flexShrink: 0, backgroundColor: tok.divider }} /> : null
            if (width !== undefined) return <TabExit key={`${item.key}:leaving`} width={width} onDone={() => setLeaving((current) => current.filter((c) => c.item.key !== item.key))}>{body}</TabExit>
            if (fresh.current.has(item.key)) return [<TabEnter key={item.key} onDone={() => fresh.current.delete(item.key)}>{body}</TabEnter>, divider]
            return [props.wrapTab ? <div key={item.key} style={{ display: 'flex', flexShrink: 0 }}>{props.wrapTab(item.key, body)}</div> : body, divider]
          })}
          {dropIndex !== null && dropIndex >= items.length && <DropLine color={tok.accent} />}
        </div>
      </div>
      {overflowing && <div style={{ display: 'flex', flexShrink: 0, marginRight: trailing ? 4 : 0 }}><OverflowMenu items={items} active={active} onSelect={onSelect} size={size} testId={testId} /></div>}
      {trailing}
    </div>
  )
})

function DropLine({ color }: { color: string }) {
  return <div style={{ width: 2, height: 18, borderRadius: 1, marginLeft: -2, flexShrink: 0, backgroundColor: color, pointerEvents: 'none' }} />
}

/**
 * A new tab fades in from scale 0.97 (150 ms, `EASE.out`; paint-only, so no layout per frame). Its width is not known before it
 * lays out and GPUIX tweens no `maxWidth`, so the neighbours step aside at once rather than slide. Reduce Motion: opacity, 90 ms.
 */
function TabEnter({ onDone, children }: { onDone: () => void; children: ReactNode }) {
  const enter = REDUCED_MOTION
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: 0.09, ease: [...EASE.out] as [number, number, number, number] } }
    : { initial: { opacity: 0, scale: 0.97 }, animate: { opacity: 1, scale: 1 }, transition: { duration: 0.15, ease: [...EASE.out] as [number, number, number, number] } }
  useEffect(() => { const timer = setTimeout(onDone, 200); return () => clearTimeout(timer) }, [])
  return <div paintTransform={enter} style={{ display: 'flex', flexShrink: 0 }}>{children}</div>
}

/** A closed tab: its measured width → 0 with opacity, 120 ms, out of the way of the pointer. */
function TabExit({ width, onDone, children }: { width: number; onDone: () => void; children: ReactNode }) {
  useEffect(() => { const timer = setTimeout(onDone, 260); return () => clearTimeout(timer) }, [])
  if (REDUCED_MOTION) return <motion.div initial={{ opacity: 1 }} animate={{ opacity: 0 }} transition={{ duration: 0.09, ease: [...EASE.out] }} onMotionComplete={onDone} style={{ display: 'flex', flexShrink: 0, width: 0, overflow: 'hidden', pointerEvents: 'none' }}>{children}</motion.div>
  return <motion.div initial={{ opacity: 1, width }} animate={{ opacity: 0, width: 0 }} transition={{ duration: 0.12, ease: [...EASE.out] }} onMotionComplete={onDone}
    style={{ display: 'flex', flexShrink: 0, overflow: 'hidden', pointerEvents: 'none' }}>{children}</motion.div>
}

const TabView = memo(function TabView({ item, index, size, active, focused, props, tok, geometry, register, drop, separator, onHover }: {
  item: TabsItem; index: number; size: 'md' | 'sm'; active: boolean; focused: boolean; props: TabsProps
  tok: ReturnType<typeof tabTokens>; geometry: (typeof GEOMETRY)['md' | 'sm']; register: (node: PublicInstance | null) => void; drop: boolean
  separator: boolean; onHover: (update: (key: string | null) => string | null) => void
}) {
  const t = useTheme()
  const { renderer } = useGpuix()
  const [hover, setHover] = useState(false)
  const node = useRef<PublicInstance | null>(null)
  const closable = !item.pinned && !!props.onClose
  const showClose = closable && (hover || (active && !item.dirty))
  const dim = active && !focused
  const labelColor = item.disabled ? t.textTertiary : active ? (dim ? t.textSecondary : t.text) : hover ? t.text : t.textSecondary
  const iconColor = active && !dim ? t.text : t.textSecondary
  const minWidth = props.minWidth ?? 96
  const underlineGap = props.underlineGap ?? (size === 'md' ? 9 : 4)
  const glyphNode = item.iconNode ?? (item.mark ? <ProviderMark kind={item.mark} size={geometry.glyph} /> : item.icon ? <Icon source={item.icon} size={geometry.glyph} color={iconColor} /> : null)
  // A label longer than the tab's room fades out at its trailing edge instead of ending in "…" (the tooltip has the rest).
  // Its width is estimated from the character count, as `clip` does; the stock addon has no fade and keeps the ellipsis.
  const room = (item.pinned ? pinnedMax(item) : MAX) - geometry.pad - (glyphNode ? geometry.glyph + 6 : 0) - (closable ? 6 + CLOSE + geometry.pad - 3 : geometry.pad)
  const fade = EDGE_FADE && !item.iconOnly && !item.detail && !item.extra && item.label.length * geometry.text * 0.53 > room
  const label = item.iconOnly ? null : item.preview
    ? <ItalicLabel text={item.label} size={geometry.text} color={labelColor} fade={fade} />
    : <Label color={labelColor} size={geometry.text} weight={500} lineHeight={geometry.text + 3} truncate={!fade} style={fade ? { whiteSpace: 'nowrap', overflow: 'hidden', minWidth: 0, flexShrink: 1 } : undefined}>{item.label}</Label>
  // The wrapper owns the box (hover fill, underline, drop line); the hit area and the ✕ are siblings inside it, so a press on
  // the ✕ never selects the tab or starts a drag.
  const hit = (
    <div
      testId={item.testId ?? `tab-${item.key}`}
      role="tab"
      aria-selected={active}
      aria-label={item.tooltip ?? item.label}
      tabIndex={active ? 0 : -1}
      onMouseDown={(event) => {
        if ((event.button ?? 0) !== 0) return
        props.onTabMouseDown?.(item.key, event, node.current ? renderer?.getElementBounds?.(node.current.id) ?? null : null)
      }}
      onMouseUp={(event) => props.onTabMouseUp?.(item.key, event)}
      onMouseMove={props.onTabMouseMove ? (event) => props.onTabMouseMove!(item.key, event, false) : undefined}
      onMouseLeave={props.onTabMouseMove ? (event) => props.onTabMouseMove!(item.key, event, true) : undefined}
      onClick={(event) => {
        if (item.disabled) return
        if ((event.clickCount ?? 1) >= 2) props.onDoubleClick?.(item.key)
        else props.onSelect(item.key)
      }}
      onKeyDown={(event) => {
        if (event.key === 'enter' || event.key === 'space') { if (!item.disabled) props.onSelect(item.key) }
        else if (event.key === 'left' || event.key === 'right') {
          // From the tab's place among the live items (`index` also counts tabs still animating out).
          const at = Math.max(0, props.items.findIndex((i) => i.key === item.key))
          const next = props.items[(at + (event.key === 'left' ? props.items.length - 1 : 1)) % props.items.length]
          if (next) props.onSelect(next.key)
        }
      }}
      style={{ display: 'flex', alignItems: 'center', gap: 6, flexGrow: 1, flexShrink: 1, minWidth: 0, height: geometry.height, paddingLeft: geometry.pad, paddingRight: closable ? 6 : geometry.pad, cursor: 'pointer' }}
    >
      {glyphNode && <div style={{ display: 'flex', width: geometry.glyph, height: geometry.glyph, alignItems: 'center', justifyContent: 'center', flexShrink: 0, pointerEvents: 'none' }}>{glyphNode}</div>}
      {label && <div edgeFade={fade ? LABEL_FADE : undefined} style={{ display: 'flex', alignItems: 'center', flexGrow: 1, flexShrink: 1, minWidth: 0, pointerEvents: 'none', ...(fade ? { overflow: 'hidden' } : {}) }}>{label}</div>}
      {item.detail && <Label color={t.textTertiary} size={geometry.text - 1} style={{ flexShrink: 0 }}>{item.detail}</Label>}
      {item.extra}
      {!closable && item.dirty && <div style={{ width: 6, height: 6, borderRadius: 3, flexShrink: 0, backgroundColor: t.textSecondary }} />}
    </div>
  )
  const tab = (
    <div
      ref={(el) => { node.current = el; register(el) }}
      onMouseEnter={() => { setHover(true); onHover(() => item.key) }}
      onMouseLeave={() => { setHover(false); onHover((key) => key === item.key ? null : key) }}
      style={{
        display: 'flex', alignItems: 'center', height: geometry.height, minWidth: item.pinned ? undefined : minWidth, maxWidth: item.pinned ? pinnedMax(item) : MAX, flexShrink: 0,
        paddingRight: closable ? geometry.pad - 3 : 0, borderRadius: 8, position: 'relative', ...(item.disabled ? { opacity: 0.55 } : {}),
        hover: { backgroundColor: tok.hover },
      }}
    >
      {separator && <div style={{ position: 'absolute', left: -(props.gap ?? 2) / 2 - 0.5, top: (geometry.height - 16) / 2, width: 1, height: 16, backgroundColor: tok.divider, pointerEvents: 'none' }} />}
      {drop && <div style={{ position: 'absolute', left: -2, top: (geometry.height - 18) / 2, width: 2, height: 18, borderRadius: 1, backgroundColor: tok.accent, pointerEvents: 'none' }} />}
      {hit}
      {closable && (
        <div
          testId={item.closeTestId ?? `${item.testId ?? `tab-${item.key}`}-close`}
          role="button"
          aria-label={`Close ${item.label}`}
          onClick={() => props.onClose?.(item.key)}
          paintTransform={pressTransform(showClose)}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: CLOSE, height: CLOSE, borderRadius: 5, flexShrink: 0, cursor: 'pointer', pointerEvents: showClose ? 'auto' : 'none', hover: { backgroundColor: tok.closeHover } }}
        >
          {showClose ? <Icon source={X} size={11} color={hover ? t.text : t.textTertiary} /> : item.dirty ? <div style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: t.textSecondary }} /> : null}
        </div>
      )}
      {active && (props.items.length > 1 || props.markSingle) && <div testId={`${item.testId ?? `tab-${item.key}`}-underline`} style={{ position: 'absolute', left: 8, right: 8, bottom: -underlineGap, height: 2, borderRadius: 2, backgroundColor: dim ? tok.dimLine : tok.accent, pointerEvents: 'none' }} />}
    </div>
  )
  // The full name in a tooltip when the label can be cut (documents; the pinned chat names itself in the header).
  return item.tooltip || item.iconOnly || item.label.length > 18 ? <Tip label={item.tooltip ?? item.label} side="bottom" size={geometry.height}>{tab}</Tip> : tab
})


function ItalicLabel({ text, size, color, fade = false }: { text: string; size: number; color: string; fade?: boolean }) {
  const t = useTheme()
  // Faded: a few characters past the room, cut by the fade rather than an ellipsis.
  const source = useMemo(() => `*${escapeMarkdown(fade ? text.slice(0, clipRoom(size) + 6) : clip(text, size))}*`, [text, size, fade])
  return <markdown source={source} theme={italicTheme(t, size, color)} style={{ color, userSelect: 'none', flexShrink: 1, minWidth: 0 }} />
}

/** » : every tab of the strip, in order; the active one checked. */
function OverflowMenu({ items, active, onSelect, size, testId }: { items: TabsItem[]; active: string | null; onSelect: (key: string) => void; size: 'md' | 'sm'; testId?: string }) {
  const t = useTheme()
  const box = size === 'md' ? 24 : 20
  return (
    <Menu align="end" minWidth={208} testId={testId ? `${testId}-overflow` : 'tabs-overflow'} trigger={(open) => (
      <div role="button" aria-label="Show all tabs" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: box, height: box, marginLeft: 4, borderRadius: 6, flexShrink: 0, cursor: 'pointer', ...(open ? { backgroundColor: ink(t, 0.08) } : {}), hover: { backgroundColor: ink(t, 0.06) } }}>
        <Icon source={OVERFLOW} size={14} color={t.textSecondary} />
      </div>
    )}>
      {items.map((item) => (
        <MenuItem key={item.key} id={item.key} testId={`tabs-overflow-${item.key}`} label={item.label} icon={item.icon} iconNode={item.mark ? <ProviderMark kind={item.mark} size={14} /> : item.iconNode} checked={item.key === active} onSelect={() => onSelect(item.key)} />
      ))}
    </Menu>
  )
}
