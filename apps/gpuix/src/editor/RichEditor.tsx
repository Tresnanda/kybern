// The one formatted editor: notes, task descriptions and the dock's Notes tab.
// A native `<rich-editor>` (native/patches/rich_editor.rs) edits the document in
// place with the reading look (desktop `NoteBody` + `.note-prose`); this component
// feeds it Markdown, reads Markdown back, and draws the desktop's slash menu,
// selection format bar and link bubble around it. See src/editor/README.md.
import { useGpuix, useWindowSize, type EventPayload, type PublicInstance, type StyleDesc } from '@gpuix/react'
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { STATUS_LABEL } from '@/state/tasksModel'
import type { TaskItem } from '../../../../packages/kybern-client/src/types.ts'
import { Icon } from '../icons.tsx'
import { SLASH_ICON, TASK_ICON } from './icons.ts'
import { PopupLayer, popoverStyle } from '../composer/Menu.tsx'
import { FONT_MONO, FONT_UI, over, type Theme } from '../theme.ts'
import { ink, Label, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { notesTokens } from '../notes/kit.tsx'
import { statusGlyphSource } from '../tasks/Glyphs.tsx'
import { useTasks } from '../tasks/store.ts'
import { loadEditorImage, uploadEditorImages, type ImageHome } from './images.ts'
import { parseDoc, serializeDoc, type DocBlock, type ParsedDoc } from './markdown.ts'
import { filterSlashItems, slashItemsFor, type SlashItem } from './slash.ts'
import { FormatBar, LinkBubble } from './FormatBar.tsx'

/** What the native editor reports after edits, caret moves and focus changes. */
export interface EditorState {
  focused: boolean
  collapsed: boolean
  /** The turn-into id of the caret's block: text, h1–h3, bullet, number, checklist, code. */
  block: string
  inCode: boolean
  quote: boolean
  marks: { bold: boolean; italic: boolean; strike: boolean; code: boolean }
  link: { href: string; rect: Rect | null } | null
  /** Relative to the editor: [x, y, width, height]. */
  caret: Rect | null
  selection: Rect | null
  slash: { from: number; block: number; query: string; rect: Rect | null } | null
  canUndo: boolean
  canRedo: boolean
  empty: boolean
  headings: { level: number; text: string; y: number; index: number }[]
  height: number
  /** The checklist line under the pointer that can become a task (when `onMakeTask` is set). */
  hoverTask: MakeTaskLine & { rect: Rect } | null
}
/** A checklist line for "Make task": its block, its place among all checklist items, its words. */
export interface MakeTaskLine { block: number; index: number; title: string }
export type Rect = [number, number, number, number]

export interface RichEditorHandle {
  /** The host id of the native element. */
  readonly id: number | null
  /** Current Markdown (unchanged blocks keep their exact source). */
  read(): string
  focus(at?: 'start' | 'end'): void
  /** A native editor command (`richEditorCommand`); see README. */
  command(command: Record<string, unknown>): unknown
  state(): EditorState | null
  /** Upload image files and insert them at the caret. */
  addImages(paths: string[]): Promise<void>
}

export interface RichEditorProps {
  /** Markdown shown when `epoch` changes. */
  value: string
  /** Bump to replace the text (another device's edit, a reload); typing never needs it. */
  epoch: number
  /** The Markdown after an edit, throttled while typing and flushed on blur. */
  onChange?: (markdown: string) => void
  readOnly?: boolean
  placeholder?: string
  /** `page`: the Notes page column; `compact`: panels, quick capture, task descriptions. */
  variant?: 'page' | 'compact'
  /** Text size and line height override (`.tk-desc`: 15/24). */
  size?: number
  lineHeight?: number
  /** Body text color override (`.tk-desc`: task fg1). */
  color?: string
  /** Where pasted, dropped and chosen images are kept; null keeps the editor text-only. */
  images?: ImageHome | null
  /** The floating format bar over selected text (compact surfaces; the Notes page has a toolbar). */
  selectionBar?: boolean
  onOpenLink?: (href: string) => void
  /** Backspace at the start of an empty first line. */
  onBackspaceAtStart?: () => void
  onFocus?: () => void
  onBlur?: () => void
  onState?: (state: EditorState) => void
  /** Keys delivered to `onKeyDown` before the editor acts on them (preventDefault to keep them). */
  interceptKeys?: string[]
  onKeyDown?: (event: EventPayload & { preventDefault(): void; defaultPrevented?: boolean; requestId?: number }) => void
  /** Tasks for live reference chips beyond the tasks store (a note in another environment). */
  tasks?: Record<string, TaskItem>
  /** "Make task" on checklist lines (hover button and ⌘⇧T); unset where lines cannot become tasks. */
  onMakeTask?: (line: MakeTaskLine) => void
  /** The link bubble's Edit, where a page toolbar edits links. */
  onEditLink?: () => void
  /** The scrolling ancestor that keeps the caret in view while typing, and an unscrolled
   * element covering its visible area (a scroller's own bounds move with its content). */
  scroller?: { current: PublicInstance | null }
  viewport?: { current: PublicInstance | null }
  minHeight?: number
  testId?: string
  'aria-label'?: string
  style?: StyleDesc
  children?: ReactNode
}

const READ = 16.1538
const UI = 14
const CHANGE_THROTTLE_MS = 120

/** `color-mix(in srgb, <color> N%, transparent)` for the colors the theme produces. */
export function withAlpha(color: string, alpha: number): string {
  const c = color.trim()
  if (c.startsWith('#')) {
    const h = c.slice(1)
    const f = h.length <= 4 ? [...h].map(x => x + x).join('') : h
    const a = f.length === 8 ? parseInt(f.slice(6, 8), 16) / 255 : 1
    return `rgba(${parseInt(f.slice(0, 2), 16)}, ${parseInt(f.slice(2, 4), 16)}, ${parseInt(f.slice(4, 6), 16)}, ${+(a * alpha).toFixed(3)})`
  }
  const rgb = /^rgba?\(([^)]+)\)$/.exec(c)
  if (rgb) {
    const [r, g, b, a = '1'] = rgb[1]!.split(/[\s,/]+/).filter(Boolean)
    return `rgba(${r}, ${g}, ${b}, ${+(Number(a) * alpha).toFixed(3)})`
  }
  const fn = /^(oklch|oklab|hsl|lab|lch)\(([^/)]+)(?:\/\s*([\d.]+%?))?\)$/.exec(c)
  if (fn) {
    const base = fn[3] ? (fn[3].endsWith('%') ? Number(fn[3].slice(0, -1)) / 100 : Number(fn[3])) : 1
    return `${fn[1]}(${fn[2]!.trim()} / ${+(base * alpha).toFixed(3)})`
  }
  return c
}

/** The native editor's theme: the desktop's `.note-prose` tokens (`styles/notes.css`). */
export function editorTheme(t: Theme, options: { variant: 'page' | 'compact'; size?: number; lineHeight?: number; color?: string; minHeight?: number }) {
  const k = notesTokens(t)
  const link = t.v('--color-token-text-link-foreground') || t.link
  const compact = options.variant === 'compact'
  const size = options.size ?? (compact ? UI : READ)
  const line = options.lineHeight ? options.lineHeight / size : compact ? 1.55 : 1.6
  return {
    fg: k.fg, fg1: options.color ?? k.fg1, fg2: k.fg2, fg3: k.fg3, fg4: k.fg4,
    link, fill: k.fill, hair: k.hair, hover: k.hover, sel: k.sel, checkOn: k.checkOn,
    focus: t.v('--color-border-focus') || t.accentBlue, surface: t.surface,
    selection: withAlpha(link, 0.28), caret: k.fg,
    font: FONT_UI, mono: FONT_MONO, size, line, compact, minHeight: options.minHeight ?? 0, reducedMotion: REDUCED_MOTION,
  }
}

const TICK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M4.4 8.3l2.4 2.4L11.6 5.6" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const PENDING = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 14"><circle cx="7" cy="7" r="6.2" fill="none" stroke="currentColor" stroke-width="1.25" stroke-dasharray="1.6 1.6"/></svg>'

function useGlyphs(t: Theme) {
  return useMemo(() => {
    const k = notesTokens(t)
    const out: Record<string, { svg: string; color: string }> = { tick: { svg: TICK, color: t.surface }, pending: { svg: PENDING, color: k.fg4 } }
    for (const status of Object.keys(STATUS_LABEL) as (keyof typeof STATUS_LABEL)[]) out[status] = statusGlyphSource(status, t)
    return out
  }, [t])
}

/** Live task data for reference chips: key, status and whether the task still exists. */
function useTaskInfo(extra?: Record<string, TaskItem>) {
  const tasks = useTasks(s => s.tasks)
  const loaded = useTasks(s => s.loaded)
  return useMemo(() => {
    const all = { ...tasks, ...extra }
    const info: Record<string, { key: string; status: string; statusLabel: string; state: string }> = {}
    for (const task of Object.values(all)) info[task.id.toLowerCase()] = { key: task.key, status: task.status, statusLabel: STATUS_LABEL[task.status], state: 'ok' }
    const keys: Record<string, string> = {}
    for (const task of Object.values(all)) if (task.key) keys[task.key] = task.id
    return { info, keys, loaded }
  }, [tasks, extra, loaded])
}

export const RichEditor = forwardRef<RichEditorHandle, RichEditorProps>(function RichEditor(props, ref) {
  const { value, epoch, variant = 'page', readOnly = false, images = null, selectionBar = variant === 'compact' } = props
  const t = useTheme()
  const { renderer } = useGpuix()
  const node = useRef<PublicInstance>(null)
  const [state, setState] = useState<EditorState | null>(null)
  const stateRef = useRef<EditorState | null>(null)
  const latest = useRef(props)
  latest.current = props
  // The document as last loaded: unchanged blocks are written back from its source.
  const base = useRef<ParsedDoc | null>(null)
  const applied = useRef<{ epoch: number; doc: string } | null>(null)
  if (!applied.current || applied.current.epoch !== epoch) {
    base.current = parseDoc(value)
    applied.current = { epoch, doc: JSON.stringify({ blocks: base.current.blocks }) }
  }
  const native = renderer as unknown as { richEditorCommand?: (id: number, command: Record<string, unknown>) => unknown } | null
  const command = useCallback((cmd: Record<string, unknown>) => {
    const id = node.current?.id
    if (id == null || !native?.richEditorCommand) return null
    return native.richEditorCommand(id, cmd)
  }, [native])
  const markdown = useRef<{ rev: number; text: string } | null>(null)
  const rev = useRef(0)
  const read = useCallback((): string => {
    if (markdown.current && markdown.current.rev === rev.current) return markdown.current.text
    const doc = command({ cmd: 'getDoc' }) as { blocks: DocBlock[] } | null
    if (!doc || !base.current) return latest.current.value
    const text = serializeDoc(doc.blocks, base.current)
    markdown.current = { rev: rev.current, text }
    return text
  }, [command])
  // Throttled Markdown for the owner's session; flushed on blur and unmount.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flush = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    if (!markdown.current || markdown.current.rev !== rev.current) latest.current.onChange?.(read())
  }, [read])
  useEffect(() => () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; latest.current.onChange?.(read()) } }, [read])
  // A new document replaces the edit counter's baseline.
  useLayoutEffect(() => { markdown.current = { rev: rev.current, text: value } }, [epoch])

  const addImages = useCallback(async (paths: string[]) => {
    const home = latest.current.images
    if (!home || !paths.length) return
    const inserted = await uploadEditorImages(home, paths)
    for (const image of inserted) {
      command({ cmd: 'insertImage', src: image.src, alt: image.alt })
      void loadEditorImage(renderer, home, image.src)
    }
  }, [command, renderer])

  useImperativeHandle(ref, () => ({
    get id() { return node.current?.id ?? null },
    read,
    focus: (at) => { command({ cmd: 'focus', ...(at ? { at } : {}) }) },
    command,
    state: () => stateRef.current,
    addImages,
  }), [read, command, addImages])

  // Images: load every image the document shows.
  const imageSources = useMemo(() => {
    const out = new Set<string>()
    for (const block of base.current?.blocks ?? []) {
      if (block.type === 'image' && block.src) out.add(block.src)
      for (const piece of block.content ?? []) if ('atom' in piece && piece.atom.type === 'image') out.add(piece.atom.src)
    }
    return [...out]
  }, [epoch])
  useEffect(() => { for (const src of imageSources) void loadEditorImage(renderer, images, src) }, [imageSources, renderer, images])

  // Slash menu.
  const [slashIndex, setSlashIndex] = useState(0)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const slashKey = state?.slash ? `${state.slash.block}:${state.slash.from}` : null
  const slashItems = useMemo(() => state?.slash ? filterSlashItems(state.slash.query, slashItemsFor(!!images)) : [], [state?.slash?.query, !!images, slashKey])
  const slashOpen = !!state?.slash && state.focused && slashKey !== dismissed && !readOnly
  useEffect(() => { setSlashIndex(0) }, [state?.slash?.query, slashKey])
  useEffect(() => { if (!state?.slash) setDismissed(null) }, [state?.slash])
  const chooseSlash = useCallback((item: SlashItem) => {
    if (item.id === 'image') {
      command({ cmd: 'slash', item: 'image' })
      void (async () => {
        const paths = await (renderer as unknown as { promptForPaths?: (o: object) => Promise<string[] | null> } | null)?.promptForPaths?.({ files: true, directories: false, multiple: true, prompt: 'Add image' })
        if (paths?.length) await addImages(paths)
        command({ cmd: 'focus' })
      })()
      return
    }
    command({ cmd: 'slash', item: item.id })
  }, [command, renderer, addImages])

  const keys = useMemo(() => {
    const own = slashOpen ? ['up', 'down', 'enter', 'tab', 'escape'] : []
    return [...new Set([...own, ...(props.interceptKeys ?? [])])]
  }, [slashOpen, props.interceptKeys?.join()])

  const onKeyDown = (event: EventPayload & { preventDefault(): void; requestId?: number }) => {
    if (event.requestId != null && slashOpen) {
      const count = slashItems.length
      const plain = !event.modifiers?.cmd && !event.modifiers?.alt && !event.modifiers?.ctrl && !event.modifiers?.shift
      if (event.key === 'escape') { event.preventDefault(); setDismissed(slashKey); return }
      if (count && plain && event.key === 'down') { event.preventDefault(); setSlashIndex(i => (i + 1) % count); return }
      if (count && plain && event.key === 'up') { event.preventDefault(); setSlashIndex(i => (i - 1 + count) % count); return }
      if (count && plain && (event.key === 'enter' || event.key === 'tab')) { event.preventDefault(); chooseSlash(slashItems[slashIndex % count]!); return }
    }
    latest.current.onKeyDown?.(event)
  }

  const onChange = (event: EventPayload) => {
    if (!event.value) return
    let message: { t: string } & Partial<EditorState> & { rev?: number }
    try { message = JSON.parse(event.value) } catch { return }
    if (message.t === 'edit') {
      rev.current++
      if (!timer.current) timer.current = setTimeout(() => { timer.current = null; latest.current.onChange?.(read()) }, CHANGE_THROTTLE_MS)
    } else if (message.t === 'state') {
      const next = message as unknown as EditorState
      const wasFocused = stateRef.current?.focused
      const moved = next.caret?.join() !== stateRef.current?.caret?.join() || next.height !== stateRef.current?.height
      stateRef.current = next
      setState(next)
      latest.current.onState?.(next)
      if (wasFocused && !next.focused) flush()
      if (next.focused && moved) followCaret(next)
    } else if (message.t === 'backspaceAtStart') {
      latest.current.onBackspaceAtStart?.()
    } else if (message.t === 'makeTask') {
      latest.current.onMakeTask?.(message as unknown as MakeTaskLine)
    }
  }

  /** Keep the caret in view of the scrolling ancestor, like a browser does while typing. */
  const followCaret = (next: EditorState) => {
    const scroller = latest.current.scroller?.current
    const viewport = latest.current.viewport?.current ?? scroller
    const id = node.current?.id
    const r = renderer as unknown as { getElementBounds?: (id: number) => { x: number; y: number; width: number; height: number } | null; getScrollOffset?: (id: number) => number[] | null; scrollTo?: (id: number, x: number, y: number) => void } | null
    if (!scroller || id == null || !next.caret || !r?.getElementBounds || !r.getScrollOffset || !r.scrollTo) return
    const view = r.getElementBounds(viewport!.id), own = r.getElementBounds(id), offset = r.getScrollOffset(scroller.id)
    if (!view || !own || !offset) return
    const top = own.y + next.caret[1], bottom = top + next.caret[3]
    const margin = 24
    let delta = 0
    if (bottom > view.y + view.height - margin) delta = bottom - (view.y + view.height - margin)
    else if (top < view.y + 8) delta = top - (view.y + 8)
    if (delta) r.scrollTo(scroller.id, offset[0] ?? 0, Math.min(0, (offset[1] ?? 0) - delta))
  }
  /** An editor-relative rectangle in window coordinates (for popups). */
  const toWindow = (rect: Rect | null): Rect | null => {
    const id = node.current?.id
    const own = id == null ? null : (renderer as unknown as { getElementBounds?: (id: number) => { x: number; y: number } | null } | null)?.getElementBounds?.(id)
    return rect && own ? [own.x + rect[0], own.y + rect[1], rect[2], rect[3]] : null
  }

  const theme = useMemo(() => editorTheme(t, { variant, size: props.size, lineHeight: props.lineHeight, color: props.color, minHeight: props.minHeight }), [t, variant, props.size, props.lineHeight, props.color, props.minHeight])
  const glyphs = useGlyphs(t)
  const taskInfo = useTaskInfo(props.tasks)
  // Until the tasks list arrives a reference is only pending, not missing.
  const tasksProp = taskInfo.info
  const k = notesTokens(t)
  const slash = slashOpen && state?.slash?.rect ? toWindow(state.slash.rect) : null
  const windowState = state ? { ...state, caret: toWindow(state.caret), selection: toWindow(state.selection), link: state.link ? { ...state.link, rect: toWindow(state.link.rect) } : null } : null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', position: 'relative', width: '100%', ...props.style }}>
      <rich-editor
        ref={node}
        testId={props.testId}
        aria-label={props['aria-label'] ?? 'Note'}
        doc={applied.current!.doc}
        docEpoch={epoch}
        theme={theme}
        placeholder={props.placeholder ?? 'Type / for commands'}
        readOnly={readOnly}
        tasks={tasksProp}
        taskKeys={taskInfo.keys}
        glyphs={glyphs}
        makeTask={!!props.onMakeTask && !readOnly}
        interceptKeys={keys}
        onKeyDown={onKeyDown as never}
        onChange={onChange}
        onFocus={() => latest.current.onFocus?.()}
        onBlur={() => { flush(); latest.current.onBlur?.() }}
        onLinkClick={(event: EventPayload) => { if (event.value) latest.current.onOpenLink?.(event.value) }}
        onFileDrop={(event: EventPayload) => { void addImages((event.paths ?? []).filter(p => /\.(png|jpe?g|gif|webp|tiff?|heic|bmp|svg)$/i.test(p))) }}
        style={{ width: '100%' }}
      />
      {slash && <SlashMenu rect={slash} items={slashItems} index={slashIndex} query={state!.slash!.query} onHover={setSlashIndex} onChoose={chooseSlash} />}
      {selectionBar && windowState && !readOnly && <FormatBar state={windowState} command={command} />}
      {windowState && !readOnly && <LinkBubble state={windowState} command={command} onOpen={href => latest.current.onOpenLink?.(href)} onEdit={latest.current.onEditLink} inBar={selectionBar} tokens={k} />}
      {state?.hoverTask && props.onMakeTask && !readOnly && <MakeTaskButton line={state.hoverTask} compact={variant === 'compact'} onClick={() => props.onMakeTask?.(state.hoverTask!)} />}
      {props.children}
    </div>
  )
})

/** `.task-line-make-button`: "Make task" at the end of the hovered checklist line. */
function MakeTaskButton({ line, compact, onClick }: { line: MakeTaskLine & { rect: Rect }; compact: boolean; onClick: () => void }) {
  const t = useTheme()
  const k = notesTokens(t)
  const row = over(k.hover, t.surface)
  const [x, y, w, h] = line.rect
  return <div testId="editor-make-task" role="button" aria-label="Make a task from this line (⌘⇧T)" onClick={onClick}
    style={{ position: 'absolute', left: x + w - 120, top: y, width: 120, height: h, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', cursor: 'pointer' }}>
    <div style={{ width: 14, height: h, background: { type: 'linear-gradient', angle: 90, stops: [{ color: withAlpha(row, 0), position: 0 }, { color: row, position: 0.86 }] } }} />
    <div style={{ display: 'flex', alignItems: 'center', gap: 5, height: h, backgroundColor: row, hover: { opacity: 1 } }}>
      <Icon source={TASK_ICON} size={13} color={k.fg2} />
      <Label color={k.fg2} size={compact ? 12 : 13} style={{ pointerEvents: 'none' }}>Make task</Label>
    </div>
  </div>
}

const SLASH_MENU_WIDTH = 288
/** The "/" menu (desktop `SlashMenu.tsx`): below the caret, or above it when there is no room below. */
function SlashMenu({ rect, items, index, query, onHover, onChoose }: { rect: Rect; items: SlashItem[]; index: number; query: string; onHover: (index: number) => void; onChoose: (item: SlashItem) => void }) {
  const t = useTheme()
  const { renderer } = useGpuix()
  const size = useWindowSize({ intervalMs: 300 })
  const rows = useRef(new Map<number, PublicInstance>())
  const [x, y, , h] = rect
  const below = size.height - (y + h)
  const above = below < 320 && y > below
  const left = Math.max(8, Math.min(x, size.width - SLASH_MENU_WIDTH - 8))
  // `max-h-[min(20rem,45vh)]`, scrolled so the highlighted item stays in view.
  const maxHeight = Math.min(320, size.height * 0.45)
  useEffect(() => { const row = rows.current.get(index); if (row) renderer?.scrollIntoView?.(row.id) }, [index])
  return <PopupLayer testId="editor-slash-menu" still position={above ? { x: left, y: y - 6 } : { x: left, y: y + h + 6 }} anchor={above ? 'bottomLeft' : 'topLeft'} kind="menu"
    style={{ ...popoverStyle(t), display: 'flex', flexDirection: 'column', width: SLASH_MENU_WIDTH }}>
    <div testId="editor-slash-list" role="listbox" aria-label="Insert" style={{ display: 'flex', flexDirection: 'column', maxHeight, overflow: 'scroll', padding: 6 }}>
      {items.length === 0
        ? <div style={{ paddingLeft: 10, paddingRight: 10, paddingTop: 8, paddingBottom: 8 }}><Label color={ink(t, 0.4)} size={13}>{`No blocks match “${query}”`}</Label></div>
        : items.map((item, i) => <div key={item.id} ref={(node) => { if (node) rows.current.set(i, node); else rows.current.delete(i) }} testId={`editor-slash-${item.id}`} role="option" aria-selected={i === index}
            onMouseEnter={() => onHover(i)} onClick={() => onChoose(item)}
            style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 36, flexShrink: 0, paddingLeft: 10, paddingRight: 10, paddingTop: 6, paddingBottom: 6, borderRadius: 8, cursor: 'pointer', backgroundColor: i === index ? t.buttonSecondary : undefined }}>
            <div style={{ display: 'flex', width: 16, height: 16, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Icon source={SLASH_ICON[item.icon]} size={16} color={ink(t, 0.85)} /></div>
            <div style={{ flexGrow: 1, minWidth: 0 }}><Label color={t.text} size={14} truncate>{item.title}</Label></div>
            {item.shortcut ? <Label color={ink(t, 0.36)} size={13} font={FONT_MONO}>{item.shortcut}</Label> : null}
          </div>)}
    </div>
  </PopupLayer>
}
