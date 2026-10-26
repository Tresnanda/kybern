import { toast } from '../shell/toasts.tsx'
import { createTask, openTask } from '../tasks/store.ts'
import { checklistLine } from '@/state/noteLines'
import { goPage } from '../nav/history.ts'
import { motion, useGpuix, useWindowSize, type PublicInstance } from '@gpuix/react'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { editedAgo } from '@/state/notesModel'
import { countWords, wordCountLabel } from '@/state/miniMarkdown'
import { LIST_STATUS_ORDER, STATUS_LABEL } from '@/state/tasksModel'
import { StatusGlyph } from '../tasks/Glyphs.tsx'
import { NOTES_META, ProjectDot, useNotesTokens } from './kit.tsx'
import type { TaskItem } from '../../../../packages/kybern-client/src/types.ts'
import { addWindowKeyHandler } from '../nav/keys.ts'
import { getNav } from '../nav/store.ts'
import { openThread } from '../nav/history.ts'
import { Button } from '../kit/Button.tsx'
import { observeElementBounds } from '../native/layout.ts'
import { onWindowVisibility } from '../native/visibility.ts'
import { useApp } from '../state.ts'
import { EASE_OUT, REDUCED_MOTION, Label, ink, useTheme } from '../ui.tsx'
import { display, gallery, getNotes, restoreNote, rpc, useNotes } from './store.ts'
import { noteSession } from './session.ts'
import { Toolbar } from './Toolbar.tsx'
import { noteBannerIn, noteDocIn } from './motion.ts'
import { SwapOnChange } from '../motion/kit.tsx'
import { RichEditor, withAlpha, type EditorState, type MakeTaskLine, type RichEditorHandle } from '../editor/RichEditor.tsx'
import type { ImageHome } from '../editor/images.ts'
import { plainText as docText, type DocBlock } from '../editor/markdown.ts'
import { NOTES_HISTORY_COPY, NOTE_CATEGORIES, supersededLabel, supersededLines } from '../../../../packages/kybern-client/src/notesHistory.ts'
import type { NoteCategory } from '../../../../packages/kybern-client/src/types.ts'
import { Menu, MenuItem } from '../nav/overlay.tsx'
import { FONT_MONO } from '../theme.ts'
import { supersededBlocks, type SupersededBlock } from './superseded.ts'
import { openQuietly } from '../platform/os.ts'
import { isPrimaryNotAltGr } from '../platform/keys.ts'

/** The text a reader counts: no link targets, list numbers, fences or heading marks. */
function plainText(body: string): string {
  return body.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\]\([^)]*\)/g, ']').replace(/^\s*```.*$/gm, '').replace(/^[\s>]*(?:\d+\.|[-*+])\s+(?:\[[ xX]\]\s+)?/gm, '').replace(/^#{1,6}\s+/gm, '')
}
export function openLink(href: string, _noteId?: string) {
  const task = /^kybern:\/\/task\/([a-f\d-]{36})\/?$/i.exec(href)
  if (task) { openTask(task[1]!); goPage('tasks'); return }
  const thread = /^kybern:\/\/thread\/([a-f\d-]{36})\/?$/i.exec(href)
  if (thread) { openThread(thread[1]!); return }
  if (/^(https?:|mailto:|tel:)/i.test(href)) openQuietly(href)
}
/** Where a note's images are kept: the daemon that keeps the note. */
export function noteImageHome(id: string): ImageHome {
  return { endpoint: () => { try { return rpc(id).endpoint } catch { return null } } }
}
/** `.note-outline` sits 120px below the scroll top as its reading line. */
const READING_LINE = 120
/** `width`: the note is a tab beside a chat (ADE-54): it lays out by its own width, not the window's, and Escape stays put. */
/** `onClose`: the editor is a tab (ADE-54); a missing note offers to close it instead of leaving for the Notes page. */
export function NoteEditor({ id, compact = false, width, onClose }: { id: string; compact?: boolean; width?: number; onClose?: () => void }) {
  const t = useTheme()
  const k = useNotesTokens()
  const { renderer } = useGpuix()
  const size = useWindowSize({ intervalMs: 300 })
  const room = width ?? size.width - 60
  const docWidth = Math.min(640, room - 48)
  const session = useMemo(() => noteSession(id), [id])
  const snap = useSyncExternalStore(session.subscribe, session.getSnapshot)
  const summary = useNotes((s) => s.notes.find((n) => n.id === id))
  const outline = useNotes((s) => s.display.outline)
  const projects = useApp((s) => s.projects)
  const [allTasks, setTasks] = useState<TaskItem[]>([])
  const tasks = allTasks.filter((task) => task.note_ids.includes(id) || task.source_note_id === id || snap.body.includes(`kybern://task/${task.id}`))
  const taskMap = useMemo(() => Object.fromEntries(allTasks.map(task => [task.id, task])), [allTasks])
  const editor = useRef<RichEditorHandle>(null)
  const scroller = useRef<PublicInstance>(null)
  const viewport = useRef<PublicInstance>(null)
  const title = useRef<PublicInstance>(null)
  const [state, setState] = useState<EditorState | null>(null)
  const [outlineActive, setOutlineActive] = useState(0)
  const images = useMemo(() => noteImageHome(id), [id])
  useEffect(() => { session.attach(); const off = onWindowVisibility((visible) => { if (!visible) void session.flush() }); return () => { off(); session.detach() } }, [session])
  useEffect(() => {
    let live = true
    const refresh = () => { void rpc(id).call('tasks.items.list', {}).then((r) => { if (live) setTasks(r.tasks) }).catch(() => {}) }
    refresh()
    const off = rpc(id).onNotification('tasks.items.changed', refresh)
    return () => { live = false; off() }
  }, [id])
  const editing = !!state?.focused
  useEffect(() => addWindowKeyHandler((e) => {
    if (getNav().paletteOpen || getNav().settingsOpen || getNotes().quick || getNotes().capture) return
    if (isPrimaryNotAltGr(e.modifiers) && e.key === 's') { void session.flush(); return true }
    if (!compact && width === undefined && e.key === 'escape' && !editing) { gallery(); return true }
  }), [session, editing, compact, width])
  const finish = () => { renderer?.blur?.(); void session.flush() }
  // The document rises in when a pointer opened it (gallery click, New note); Enter and ⌘N show it at once. Banners that
  // appear later play their own entrance, those present when the note opened are part of the page's.
  const [docIn] = useState(() => (compact || getNav().keyboardNav ? undefined : noteDocIn()))
  const [openedAt] = useState(() => Date.now())
  // "Make task" from a checklist line (desktop `noteTaskActions.ts`): save the note so the
  // daemon finds the line, then make the task; the daemon ends the line with its link.
  const making = useRef(new Set<string>())
  const makeTask = async (line: MakeTaskLine) => {
    if (!line.title) { toast('Write the line first, then make it a task'); return }
    if (making.current.has(line.title)) return
    making.current.add(line.title)
    try {
      const markdown = editor.current?.read() ?? session.getSnapshot().body
      if (markdown !== session.getSnapshot().body) session.edit({ body: markdown })
      await session.flush()
      if (session.getSnapshot().status !== 'saved') { toast.error('Unable to make a task', { description: 'This note has changes that are not saved yet. Save it, then try again.' }); return }
      const note = session.getSnapshot().note
      const projectId = note?.scope === 'project' ? note.project_id ?? null : null
      const lineText = checklistLine(markdown, line.index) ?? line.title
      const task = await createTask({ scope: projectId ? 'project' : 'global', project_id: projectId, title: line.title, status: 'todo', note_ids: [id], source: { note_id: id, line_text: lineText } })
      toast(`${task.key} created`, { action: { label: 'Open', onClick: () => { openTask(task.id); goPage('tasks') } } })
    } catch (error) { toast.error('Unable to make a task', { description: String(error) }) }
    finally { making.current.delete(line.title) }
  }
  const insertImage = async () => {
    const paths = await renderer?.promptForPaths?.({ files: true, multiple: true, prompt: 'Add image' })
    if (!paths?.length) return
    try { await editor.current?.addImages(paths) } catch (error) { toast.error('Couldn’t add image', { description: String(error) }) }
  }
  // Words in the document, read again a moment after typing pauses (desktop `useDocumentStats`).
  const [words, setWords] = useState<number | null>(null)
  useEffect(() => {
    const timer = setTimeout(() => {
      const doc = editor.current?.command({ cmd: 'getDoc' }) as { blocks: DocBlock[] } | null
      if (doc) setWords(countWords(docText(doc.blocks)))
    }, 300)
    return () => clearTimeout(timer)
  }, [snap.body, snap.epoch, state?.canUndo, state?.height])
  // Retired claims (`~~line~~ (superseded date)`) are struck through by the editor; they are also dimmed and, where the page has a
  // right margin, labelled "Superseded Oct 25". Their places are read once after typing pauses, and only when the note has any.
  const [superseded, setSuperseded] = useState<SupersededBlock[]>([])
  useEffect(() => {
    if (compact || !supersededLines(snap.body).length) { setSuperseded((old) => old.length ? [] : old); return }
    const timer = setTimeout(() => {
      const doc = editor.current?.command({ cmd: 'getDoc' }) as { blocks: DocBlock[] } | null
      const layout = editor.current?.command({ cmd: 'layout' }) as { blocks: { top: number; height: number; ty: number; lineHeight: number | null }[] } | null
      const next = doc && layout ? supersededBlocks(doc.blocks, layout.blocks) : []
      setSuperseded((old) => old.length === next.length && old.every((b, i) => b.top === next[i]!.top && b.height === next[i]!.height && b.date === next[i]!.date) ? old : next)
    }, 300)
    return () => clearTimeout(timer)
  }, [snap.body, snap.epoch, state?.height, docWidth, compact])
  const headings = (state?.headings ?? []).slice(0, 80)
  // Desktop `hasOutline`: two headings and room in the margin.
  const hasOutline = !compact && headings.length >= 2 && (width ?? size.width) >= 1050
  const editorTop = () => {
    const id = editor.current?.id
    const box = id != null ? renderer?.getElementBounds?.(id) : null
    const view = viewport.current ? renderer?.getElementBounds?.(viewport.current.id) : null
    return box && view ? { box, view } : null
  }
  const updateOutline = () => {
    const at = editorTop()
    if (!at || !headings.length) return
    let next = 0
    headings.forEach((h, i) => { if (at.box.y + h.y <= at.view.y + READING_LINE) next = i })
    setOutlineActive(old => old === next ? old : next)
  }
  const minimumHeadingLevel = Math.min(...headings.map(h => h.level))
  const activeOutlineIndex = Math.min(outlineActive, Math.max(0, headings.length - 1))
  const outlineSignature = headings.map(h => `${h.index}:${h.y}`).join('\n')
  useEffect(() => { setOutlineActive(0) }, [id])
  useEffect(() => {
    const id = editor.current?.id
    if (!renderer || compact || !outline || size.width < 1050 || id == null) return
    let timer: ReturnType<typeof setTimeout> | undefined
    // The editor moves when the page scrolls; read the headings once per painted move.
    const stop = observeElementBounds(renderer, id, () => {
      if (timer !== undefined) return
      timer = setTimeout(() => { timer = undefined; updateOutline() }, 0)
    })
    updateOutline()
    return () => { if (timer !== undefined) clearTimeout(timer); stop() }
  }, [renderer, compact, id, outlineSignature, size.width, size.height, outline, snap.phase])
  const scrollToHeading = (y: number) => {
    const at = editorTop()
    const offset = scroller.current ? renderer?.getScrollOffset?.(scroller.current.id) : null
    if (!at || !offset || !scroller.current) return
    const contentY = at.box.y - at.view.y - (offset[1] ?? 0) + y
    renderer?.scrollTo?.(scroller.current.id, 0, -Math.max(0, contentY - 96))
  }
  const note = summary ?? snap.note
  const deleted = !!(summary ? summary.deleted_at : snap.note?.deleted_at)
  // The label swaps once per save, when "Saving…" settles into "Edited …"; "Unsaved changes" -> "Saving…" and the minute-by-minute age update in place.
  const [saveEra, setSaveEra] = useState(0)
  const [lastStatus, setLastStatus] = useState(snap.status)
  if (lastStatus !== snap.status) { setLastStatus(snap.status); if (snap.status === 'saved') setSaveEra((n) => n + 1) }
  const status = snap.status === 'saved' ? (note ? editedAgo(note.updated_at) : 'Saved') : snap.status === 'dirty' ? 'Unsaved changes' : snap.status === 'saving' ? 'Saving…' : snap.status === 'conflict' ? 'Choose a version' : 'Couldn’t save · Retry'
  const body = (variant: 'page' | 'compact') => <RichEditor
    ref={editor}
    testId={variant === 'page' ? 'note-body' : 'thread-note-body'}
    aria-label={variant === 'page' ? 'Note' : 'Thread note'}
    value={snap.body}
    epoch={snap.epoch}
    variant={variant}
    readOnly={deleted}
    images={images}
    tasks={taskMap}
    scroller={variant === 'page' ? scroller : undefined}
    viewport={variant === 'page' ? viewport : undefined}
    onChange={(markdown) => { if (markdown !== session.getSnapshot().body) session.edit({ body: markdown }) }}
    onBlur={() => void session.flush()}
    onOpenLink={href => openLink(href, id)}
    onState={setState}
    onMakeTask={deleted ? undefined : (line) => void makeTask(line)}
    onBackspaceAtStart={() => { if (title.current && note?.scope !== 'thread') renderer?.focusElement?.(title.current.id) }}
    interceptKeys={['escape']}
    onKeyDown={(e) => { if (e.requestId != null && e.key === 'escape' && !e.defaultPrevented) { e.preventDefault(); finish() } }}
    minHeight={variant === 'page' ? 96 : 60}
  />
  if (compact) return <div testId="thread-note-editor" style={{ display: 'flex', flexDirection: 'column', minHeight: 120, maxHeight: 320, padding: 10, gap: 6, borderRadius: 8, backgroundColor: t.buttonSecondary }}>
    {snap.phase === 'ready' ? <div testId="thread-note-scroll" style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0, overflow: 'scroll' }}>{body('compact')}</div> : <Label color={t.textSecondary} size={12}>{snap.phase === 'loading' ? 'Loading note…' : snap.error ?? 'This note is unavailable.'}</Label>}
    {snap.conflict ? <div style={{ display: 'flex', gap: 6 }}><Button size="sm" danger onClick={() => session.useTheirs()}>Use theirs</Button><Button size="sm" variant="primary" onClick={() => session.keepMine()}>Keep mine</Button></div> : <div onClick={() => void session.flush()}><Label color={snap.status === 'error' ? t.red : t.textSecondary} size={11}>{status}</Label></div>}
  </div>
  return <div testId="note-editor" style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0 }}>
    {snap.phase === 'error' && <Banner opened={openedAt} title="Couldn’t open this note" detail={snap.error ?? ''}><Button onClick={() => void session.reload()}>Try again</Button></Banner>}
    {snap.phase === 'missing' && (onClose
      ? <Banner opened={openedAt} title="This note no longer exists" detail="It was deleted or moved to another workspace."><Button testId="note-close-tab" onClick={onClose}>Close tab</Button></Banner>
      : <Banner opened={openedAt} title="This note no longer exists" detail="Return to Notes to open another document."><Button onClick={gallery}>Open Notes</Button></Banner>)}
    {snap.conflict && <Banner opened={openedAt} title="This note changed on another device" detail="Keep your version to replace theirs, or use theirs and discard your changes."><Button testId="note-use-theirs" danger onClick={() => session.useTheirs()}>Use theirs</Button><Button testId="note-keep-mine" variant="primary" onClick={() => session.keepMine()}>Keep mine</Button></Banner>}
    {deleted && <Banner opened={openedAt} title="This note is in Recently deleted" detail="Restore it to edit it again."><Button testId="note-restore" variant="primary" onClick={() => void restoreNote(id)}>Restore</Button></Banner>}
    {snap.phase === 'ready' && note?.stale && !deleted && <Banner opened={openedAt} tone="warning" testId="note-stale-banner" title={NOTES_HISTORY_COPY.staleTitle} detail={<><Code>{note.stale.path}</Code><Label color={t.textSecondary} size={12}>changed in</Label><Code>{note.stale.commit}</Code></>} />}
    {snap.phase === 'ready' && <>
      <div ref={viewport} testId="note-viewport" style={{ display: 'flex', flexGrow: 1, minHeight: 0, position: 'relative' }}>
        <div ref={scroller} testId="note-body-list" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexGrow: 1, minHeight: 0, overflow: 'scroll' }}>
          <div paintTransform={docIn} style={{ display: 'flex', flexDirection: 'column', width: docWidth, paddingTop: 84, flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, minHeight: 19.5, marginBottom: 20 }}>
              <ProjectDot projectId={note?.scope === 'global' ? null : note?.project_id ?? null} /><Label color={k.fg2} size={NOTES_META} lineHeight={19.5}>{note?.scope === 'global' ? 'Global' : projects.find((p) => p.id === note?.project_id)?.name ?? 'Chats'}</Label>
              {note?.scope === 'project' && <CategoryPicker category={note.category ?? null} locked={deleted} onPick={(category) => void session.setCategory(category).catch((error) => toast.error('Unable to set the category', { description: String(error) }))} />}
              <Label color={k.fg4} size={NOTES_META} lineHeight={19.5}>·</Label>
              <div testId="note-save-status" onClick={() => { if (snap.status === 'error') void session.flush() }}><SwapOnChange active={`save:${saveEra}`} style={{ justifyContent: 'flex-start' }}><Label color={snap.status === 'error' ? t.red : k.fg3} size={NOTES_META} lineHeight={19.5}>{status}</Label></SwapOnChange></div>
            </div>
            <input ref={title} testId="note-title" autoFocus={!snap.title && !snap.body && !deleted} aria-label="Title" value={snap.title} placeholder="Untitled" readOnly={deleted} interceptKeys={['down']}
              onChange={(e) => session.edit({ title: (e.value ?? '').replace(/\s*\n\s*/g, ' ').slice(0, 300) })} onBlur={() => void session.flush()}
              onSubmit={() => editor.current?.focus('start')}
              onKeyDown={(e) => { if (e.key === 'down' && !e.modifiers?.shift) { e.preventDefault(); editor.current?.focus('start') } }}
              theme={{ text: k.fg, caret: k.fg }} style={{ width: '100%', height: 37, marginBottom: 24, fontSize: 30.15, lineHeight: 36.6, fontWeight: 650, color: k.fg }} />
            <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', width: '100%' }}>
              {body('page')}
              {superseded.map((block) => <SupersededMark key={block.index} block={block} gutter={(room - docWidth) / 2 - 12} docWidth={docWidth} />)}
            </div>
            {/* The blank space under the text is part of the page: click it to keep writing. */}
            {!deleted && <div testId="note-add-block" style={{ width: '100%', minHeight: 96, paddingBottom: 48, cursor: 'text' }} onClick={() => editor.current?.focus('end')} />}
          </div>
        </div>
        {outline && hasOutline && <div style={{ display: 'flex', flexDirection: 'column', position: 'absolute', left: 24, top: 84, width: 188 }}>
          <div style={{ marginBottom: 6 }}><Label color={k.fg3} size={NOTES_META} lineHeight={18}>Outline</Label></div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, position: 'relative' }}>
            {headings.map((h, i) => <div key={h.index} testId={`note-outline-${h.index}`} onClick={() => { scrollToHeading(h.y); setOutlineActive(i) }} style={{ display: 'flex', alignItems: 'center', height: 24, paddingTop: 4, paddingBottom: 4, paddingLeft: 9 + Math.min(2, h.level - minimumHeadingLevel) * 10, borderLeftWidth: 1, borderColor: k.hair, cursor: 'pointer' }}><Label color={i === activeOutlineIndex ? k.fg : k.fg3} size={NOTES_META} lineHeight={16} truncate style={{ pointerEvents: 'none' }}>{h.text}</Label></div>)}
            <motion.div testId={`note-outline-active-${headings[activeOutlineIndex]?.index ?? 0}`} initial={false} animate={{ translateY: activeOutlineIndex * 26 }} transition={{ duration: REDUCED_MOTION || getNav().keyboardNav ? 0 : 0.12, ease: EASE_OUT }} style={{ position: 'absolute', left: 0, top: 0, width: 2, height: 24, backgroundColor: k.fg2, pointerEvents: 'none' }} />
          </div>
        </div>}
        {!deleted && <div style={{ position: 'absolute', top: 14, left: 0, right: 0, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}><div style={{ pointerEvents: 'auto' }}>
          <Toolbar state={state} command={(cmd) => editor.current?.command(cmd)} outlineOn={outline} image={() => void insertImage()} toggleOutline={hasOutline ? () => display({ outline: !outline }) : undefined} />
        </div></div>}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 20, height: 40, paddingLeft: 20, paddingRight: 20, flexShrink: 0 }}>
        {tasks.length > 0 && <>
          <Label color={k.fg3} size={NOTES_META} lineHeight={19.5}>Linked tasks</Label>
          {[...tasks].sort((a, b) => LIST_STATUS_ORDER.indexOf(a.status) - LIST_STATUS_ORDER.indexOf(b.status) || a.rank - b.rank).slice(0, 4).map((task) => <div key={task.id} testId={`note-task-${task.id}`} onClick={() => { openTask(task.id); goPage('tasks') }} style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: -5, marginRight: -5, paddingTop: 3, paddingBottom: 3, paddingLeft: 5, paddingRight: 5, borderRadius: 6, cursor: 'pointer', hover: { backgroundColor: k.hover } }}>
            <StatusGlyph status={task.status} /><Label color={k.fg2} size={NOTES_META} lineHeight={19.5}>{task.key}</Label><Label color={k.fg3} size={NOTES_META} lineHeight={19.5}>{STATUS_LABEL[task.status]}</Label></div>)}
          {tasks.length > 4 && <Label color={k.fg3} size={NOTES_META}>{`${tasks.length - 4} more`}</Label>}
        </>}
        <div style={{ flexGrow: 1 }} /><Label color={k.fg3} size={NOTES_META} lineHeight={19.5}>{wordCountLabel(words ?? countWords(plainText(snap.body)))}</Label>
      </div>
    </>}
  </div>
}
function Banner({ title, detail, children, opened, tone, testId = 'note-banner' }: { title: string; detail: React.ReactNode; children?: React.ReactNode; opened: number; /** `warning` leads with a warning dot (a stale note). */ tone?: 'warning'; testId?: string }) {
  const t = useTheme()
  const [enter] = useState(() => (Date.now() - opened > 400 ? noteBannerIn() : undefined))
  return <div testId={testId} paintTransform={enter} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 14, backgroundColor: t.buttonSecondary }}>
    {tone === 'warning' && <div style={{ width: 8, height: 8, borderRadius: 4, flexShrink: 0, backgroundColor: t.warning }} />}
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flexGrow: 1, minWidth: 0 }}><Label color={t.text} size={13} weight={500}>{title}</Label>{typeof detail === 'string' ? <Label color={t.textSecondary} size={12}>{detail}</Label> : <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}>{detail}</div>}</div>{children}
  </div>
}
/** A path or commit inside a sentence: mono on the secondary fill, as inline code in a note. */
function Code({ children }: { children: string }) {
  const t = useTheme()
  return <div style={{ display: 'flex', alignItems: 'center', paddingLeft: 5, paddingRight: 5, borderRadius: 4, backgroundColor: ink(t, 0.06) }}><Label color={t.textSecondary} size={11.5} lineHeight={17} font={FONT_MONO}>{children}</Label></div>
}
/** The meta row's category: a small secondary control ("Decision ▾"). A deleted note shows it as plain text. */
function CategoryPicker({ category, locked, onPick }: { category: NoteCategory | null; locked: boolean; onPick: (category: NoteCategory | null) => void }) {
  const t = useTheme()
  const label = NOTE_CATEGORIES.find((c) => c.value === category)?.label ?? NOTES_HISTORY_COPY.categoryLabel
  if (locked) return category ? <Label color={t.textSecondary} size={NOTES_META} lineHeight={19.5}>{label}</Label> : null
  return <Menu align="start" minWidth={168} testId="note-category" trigger={() => <Button size="sm" chevron label={`Category: ${label}`} testId="note-category-trigger">{label}</Button>}>
    {NOTE_CATEGORIES.map((c) => <MenuItem key={c.value} id={c.value} label={c.label} checked={c.value === category} testId={`note-category-${c.value}`} onSelect={() => { if (c.value !== category) onPick(c.value) }} />)}
    {category && <MenuItem id="none" label={NOTES_HISTORY_COPY.noCategory} testId="note-category-none" onSelect={() => onPick(null)} />}
  </Menu>
}
/** A retired claim: the block dims to the muted level (a surface-coloured veil over the struck text, which the editor draws), and a
 *  tertiary "Superseded Oct 25" sits in the page's right margin when the window leaves room for it. */
function SupersededMark({ block, gutter, docWidth }: { block: SupersededBlock; gutter: number; docWidth: number }) {
  const t = useTheme()
  const k = useNotesTokens()
  return <>
    <div testId="note-superseded-veil" style={{ position: 'absolute', left: -2, top: block.top, width: docWidth + 4, height: block.height, backgroundColor: withAlpha(t.surface, 0.45), pointerEvents: 'none' }} />
    {gutter >= 112 && <div testId="note-superseded-label" style={{ position: 'absolute', left: docWidth + 12, top: block.textTop + Math.max(0, (block.lineHeight - 16) / 2), width: gutter, pointerEvents: 'none' }}><Label color={k.fg3} size={NOTES_META - 1} lineHeight={16} truncate>{supersededLabel(block.date)}</Label></div>}
  </>
}
