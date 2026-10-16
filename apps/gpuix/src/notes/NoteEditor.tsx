import { DecoratedTextarea } from '../native/decorated-input.tsx'
import { markdownInputDecorations, noteInputMarkColors } from '../native/input-marks.ts'
import { activeEnvironment } from '../shell/environment.ts'
import { httpBase } from '../../../../packages/kybern-client/src/address.ts'
import { NoteBlock } from './NoteBlock.tsx'
import { toast } from '../shell/toasts.tsx'
import { openTask } from '../tasks/store.ts'
import { goPage } from '../nav/history.ts'
import { spawn } from 'node:child_process'
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
import { Button } from '../settings/controls.tsx'
import { observeElementBounds } from '../native/layout.ts'
import { onWindowVisibility } from '../native/visibility.ts'
import { useApp } from '../state.ts'
import { EASE_OUT, REDUCED_MOTION, Label, useTheme } from '../ui.tsx'
import { display, gallery, getNotes, restoreNote, rpc, useNotes } from './store.ts'
import { noteSession } from './session.ts'
import { BLOCKS, formatBlock, splitBlocks } from './blocks.ts'
import { NoteMenu } from './NoteMenu.tsx'
import { Toolbar } from './Toolbar.tsx'

/** `--n-read`: 15 at the chat size of 13, scaled with it (16.15 at 14). */
const READ = 16.1538
const HEADING = 18.3077
/** The text a reader counts: no link targets, list numbers, fences or heading marks. */
function plainText(body: string): string {
  return body.replace(/\]\([^)]*\)/g, ']').replace(/^\s*```.*$/gm, '').replace(/^\s*(?:\d+\.|[-*+])\s+/gm, '').replace(/^#{1,6}\s+/gm, '')
}
/** The gap above a block (`.note-prose`): .93em between blocks, more above headings, less below. */
function blockGap(prev: string, body: string): number {
  const level = /^(#{1,3})\s/.exec(body)?.[1]?.length
  // `em` here is the heading's own size: 18.31px for h1/h2, the body size for h3.
  if (level) return level === 1 ? 2.25 * HEADING : level === 2 ? 2 * HEADING : 1.6 * READ
  if (/^#{1,3}\s/.test(prev)) return READ * 0.53
  return READ * 0.93
}
/** What the block-style menu shows for a block. */
function blockLabel(body: string): string {
  const first = body.trimStart()
  const h = /^(#{1,3})\s/.exec(first)?.[1]?.length
  if (h) return `Heading ${h}`
  if (/^[-*+]\s+\[[ xX]\]\s/.test(first)) return 'Checklist'
  if (/^[-*+]\s/.test(first)) return 'Bullet list'
  if (/^\d+\.\s/.test(first)) return 'Numbered list'
  if (/^>\s?/.test(first)) return 'Quote'
  if (/^```/.test(first)) return 'Code block'
  return 'Body'
}
export function openLink(href: string, _noteId?: string) {
  const task = /^kybern:\/\/task\/([a-f\d-]{36})\/?$/i.exec(href)
  if (task) { openTask(task[1]!); goPage('tasks'); return }
  const thread = /^kybern:\/\/thread\/([a-f\d-]{36})\/?$/i.exec(href)
  if (thread) { openThread(thread[1]!); return }
  if (/^(https?:|mailto:|tel:)/i.test(href)) { const child = spawn('open', [href], { stdio: 'ignore' }); child.on('error', () => {}) }
}
export function NoteEditor({ id, compact = false }: { id: string; compact?: boolean }) {
  const t = useTheme()
  const k = useNotesTokens()
  const { renderer } = useGpuix()
  const size = useWindowSize({ intervalMs: 300 })
  const docWidth = Math.min(640, size.width - 60 - 48)
  const session = useMemo(() => noteSession(id), [id])
  const snap = useSyncExternalStore(session.subscribe, session.getSnapshot)
  const summary = useNotes((s) => s.notes.find((n) => n.id === id))
  const outline = useNotes((s) => s.display.outline)
  const projects = useApp((s) => s.projects)
  const [blocks, setBlocks] = useState<string[]>([''])
  const [epoch, setEpoch] = useState(-1)
  const [active, setActive] = useState<number | null>(null)
  const [slashIndex, setSlashIndex] = useState(0)
  const [allTasks, setTasks] = useState<TaskItem[]>([])
  const tasks = allTasks.filter((task) => task.note_ids.includes(id) || task.source_note_id === id || snap.body.includes(`kybern://task/${task.id}`))
  const list = useRef<PublicInstance>(null)
  const bodyRef = useRef<PublicInstance>(null)
  const viewportRef = useRef<PublicInstance>(null)
  const blockRefs = useRef(new Map<number, PublicInstance>())
  const [outlineActive, setOutlineActive] = useState(0)
  if (epoch !== snap.epoch) { setEpoch(snap.epoch); setBlocks(splitBlocks(snap.body)) }
  useEffect(() => { session.attach(); const off = onWindowVisibility((visible) => { if (!visible) void session.flush() }); return () => { off(); session.detach() } }, [session])
  useEffect(() => {
    let live = true
    const refresh = () => { void rpc(id).call('tasks.items.list', {}).then((r) => { if (live) setTasks(r.tasks) }).catch(() => {}) }
    refresh()
    const off = rpc(id).onNotification('tasks.items.changed', refresh)
    return () => { live = false; off() }
  }, [id])
  useEffect(() => addWindowKeyHandler((e) => {
    if (getNav().paletteOpen || getNav().settingsOpen || getNotes().quick || getNotes().capture) return
    if (e.modifiers?.cmd && e.key === 's') { void session.flush(); return true }
    if (!compact && e.key === 'escape' && active === null) { gallery(); return true }
  }), [session, active, compact])
  const update = (index: number, value: string) => { const next = [...blocks]; next[index] = value; setBlocks(next); session.edit({ body: next.join('') }) }
  const finish = () => { setActive(null); setBlocks(splitBlocks(session.getSnapshot().body)); void session.flush() }
  const format = (kind: string) => {
    const at = active ?? Math.max(0, blocks.length - 1)
    update(at, formatBlock(blocks[at] ?? '', kind)); setActive(at); setSlashIndex(0)
    if (bodyRef.current) renderer?.focusElement?.(bodyRef.current.id)
  }
  const mark = (marker: string) => {
    const at = active ?? Math.max(0, blocks.length - 1)
    const raw = blocks[at] ?? ''
    const tail = /\s*$/.exec(raw)?.[0] ?? ''
    update(at, `${marker}${raw.trimEnd()}${marker}${tail}`); setActive(at)
  }
  const insertImage = async () => {
    const paths = await renderer?.promptForPaths?.({ files: true, multiple: false, prompt: 'Add image' })
    if (!paths?.[0]) return
    const client = rpc(id)
    const owner = activeEnvironment()
    try {
      const file = Bun.file(paths[0])
      if (!file.type.startsWith('image/') || file.size > 12 * 1024 * 1024) throw Error('Choose an image smaller than 12 MB.')
      const name = paths[0].split('/').pop() ?? 'Image'
      const response = await fetch(`${httpBase(client.endpoint.url)}/assets`, { method: 'POST', headers: { authorization: `Bearer ${client.endpoint.token}`, 'content-type': file.type, 'x-kybern-filename': encodeURIComponent(name) }, body: await file.arrayBuffer() })
      if (!response.ok) throw Error(`Upload failed (${response.status})`)
      const asset = await response.json() as { id: string }
      if (owner !== activeEnvironment()) return
      // Read the live session after upload: typing during network I/O must survive.
      const body = `${session.getSnapshot().body.trimEnd()}\n\n![${name.replace(/[\\[\]]/g, '\\$&')}](kybern://asset/${asset.id})\n\n`
      session.edit({ body }); setBlocks(splitBlocks(body)); setActive(null)
    } catch (error) { toast.error('Couldn’t add image', { description: String(error) }) }
  }
  const headings = blocks.flatMap((body, index) => { const match = /^(#{1,6})\s+(.+)/.exec(body); return match ? [{ index, level: match[1]!.length, text: match[2]! }] : [] }).slice(0, 80)
  const updateOutline = () => {
    if (!renderer || !list.current || !viewportRef.current || !headings.length) return
    const frame = renderer.getElementBounds?.(viewportRef.current.id)
    const anchor = renderer.getListScrollTop?.(list.current.id)
    if (!frame || !anchor) return
    const firstRow = anchor[0] ?? 0
    // Offscreen native rows retain their last bounds. Walk only the contiguous
    // painted rows at the anchor, stopping at the desktop's 120px reading line.
    let next = 0
    if (firstRow > 0) {
      const firstBlock = firstRow - 1
      for (let i = 0; i < headings.length; i++) {
        if (headings[i]!.index < firstBlock) next = i
      }
      let top = frame.y - (anchor[1] ?? 0)
      for (let index = firstBlock; index < blocks.length && top <= frame.y + 120; index++) {
        const node = blockRefs.current.get(index)
        const box = node && renderer.getElementBounds?.(node.id)
        if (!box || box.height <= 0) break
        const heading = headings.findIndex(h => h.index === index)
        const gap = index === 0 ? 0 : blockGap(blocks[index - 1]!, blocks[index]!)
        if (heading >= 0 && top + gap <= frame.y + 120) next = heading
        top += box.height
      }
    }
    setOutlineActive(old => old === next ? old : next)
  }
  const minimumHeadingLevel = Math.min(...headings.map(h => h.level))
  const activeOutlineIndex = Math.min(outlineActive, Math.max(0, headings.length - 1))
  const outlineSignature = headings.map(h => `${h.index}:${h.text}`).join('\n')
  useEffect(() => { setOutlineActive(0) }, [id])
  useEffect(() => {
    if (!renderer || compact || !outline || size.width < 1050) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = () => {
      if (timer !== undefined) return
      timer = setTimeout(() => { timer = undefined; updateOutline() }, 0)
    }
    // Scroll notifications precede paint. Observe the painted heading positions
    // instead, coalescing this frame's changed bounds into one reading-line check.
    const stops = headings.flatMap(h => {
      const node = blockRefs.current.get(h.index)
      return node ? [observeElementBounds(renderer, node.id, schedule)] : []
    })
    schedule()
    return () => { if (timer !== undefined) clearTimeout(timer); stops.forEach(stop => stop()) }
  }, [renderer, compact, id, epoch, outlineSignature, size.width, size.height, outline])
  const slash = active !== null && /^\/[\w ]*$/.test(blocks[active] ?? '')
  const slashItems = slash ? BLOCKS.filter((b) => b.label.toLowerCase().includes((blocks[active!] ?? '').slice(1).toLowerCase())) : []
  const note = summary ?? snap.note
  const deleted = !!(summary ? summary.deleted_at : snap.note?.deleted_at)
  const status = snap.status === 'saved' ? (note ? editedAgo(note.updated_at) : 'Saved') : snap.status === 'dirty' ? 'Unsaved changes' : snap.status === 'saving' ? 'Saving…' : snap.status === 'conflict' ? 'Choose a version' : 'Couldn’t save · Retry'
  if (compact) return <div testId="thread-note-editor" style={{ display: 'flex', flexDirection: 'column', height: 200, padding: 10, gap: 6, borderRadius: 8, backgroundColor: t.buttonSecondary }}>
    {snap.phase === 'ready' ? <DecoratedTextarea decorations={markdownInputDecorations(snap.body, noteInputMarkColors(t))} testId="thread-note-body" aria-label="Thread note" value={snap.body} minRows={4} maxRows={6} readOnly={deleted} placeholder="Ideas, reminders, to-dos. Write Markdown here" onChange={(e) => session.edit({ body: e.value ?? '' })} onBlur={() => void session.flush()} theme={{ text: t.text, caret: t.text }} style={{ flexGrow: 1, width: '100%', fontSize: 12, lineHeight: 20, color: t.text, backgroundColor: t.buttonSecondary }} /> : <Label color={t.textSecondary} size={12}>{snap.phase === 'loading' ? 'Loading note…' : snap.error ?? 'This note is unavailable.'}</Label>}
    {snap.conflict ? <div style={{ display: 'flex', gap: 6 }}><Button onClick={() => session.useTheirs()}>Use theirs</Button><Button onClick={() => session.keepMine()}>Keep mine</Button></div> : <div onClick={() => void session.flush()}><Label color={snap.status === 'error' ? t.red : t.textSecondary} size={11}>{status}</Label></div>}
  </div>
  return <div testId="note-editor" style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0 }}>
    {snap.phase === 'error' && <Banner title="Couldn’t open this note" detail={snap.error ?? ''}><Button onClick={() => void session.reload()}>Try again</Button></Banner>}
    {snap.phase === 'missing' && <Banner title="This note no longer exists" detail="Return to Notes to open another document."><Button onClick={gallery}>Open Notes</Button></Banner>}
    {snap.conflict && <Banner title="This note changed on another device" detail="Keep your version to replace theirs, or use theirs and discard your changes."><Button testId="note-use-theirs" onClick={() => session.useTheirs()}>Use theirs</Button><Button testId="note-keep-mine" onClick={() => session.keepMine()}>Keep mine</Button></Banner>}
    {deleted && <Banner title="This note is in Recently deleted" detail="Restore it to edit it again."><Button testId="note-restore" onClick={() => void restoreNote(id)}>Restore</Button></Banner>}
    {snap.phase === 'ready' && <>
      <div ref={viewportRef} testId="note-viewport" style={{ display: 'flex', flexGrow: 1, minHeight: 0, position: 'relative' }}>
        <virtual-list ref={list} testId="note-body-list" style={{ flexGrow: 1, minHeight: 0 }}>
          <div key="heading" style={{ display: 'flex', justifyContent: 'center', paddingTop: 84 }}><div style={{ display: 'flex', flexDirection: 'column', width: docWidth }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, minHeight: 19.5, marginBottom: 20 }}>
              <ProjectDot projectId={note?.scope === 'global' ? null : note?.project_id ?? null} /><Label color={k.fg2} size={NOTES_META} lineHeight={19.5}>{note?.scope === 'global' ? 'Global' : projects.find((p) => p.id === note?.project_id)?.name ?? 'Chats'}</Label>
              <Label color={k.fg4} size={NOTES_META} lineHeight={19.5}>·</Label>
              <div testId="note-save-status" onClick={() => { if (snap.status === 'error') void session.flush() }}><Label color={snap.status === 'error' ? t.red : k.fg3} size={NOTES_META} lineHeight={19.5}>{status}</Label></div>
            </div>
            <input testId="note-title" autoFocus={!snap.title && !snap.body && !deleted} aria-label="Title" value={snap.title} placeholder="Untitled" readOnly={deleted || note?.scope === 'thread'} onChange={(e) => session.edit({ title: (e.value ?? '').replace(/\s*\n\s*/g, ' ').slice(0, 300) })} onBlur={() => void session.flush()} onSubmit={() => setActive(0)} theme={{ text: k.fg, caret: k.fg }} style={{ width: '100%', height: 37, marginBottom: 24, fontSize: 30.15, lineHeight: 36.6, fontWeight: 650, color: k.fg, backgroundColor: t.surface }} />
          </div></div>
          {blocks.map((body, index) => <div key={`${epoch}:${index}`} ref={(node) => { if (node) blockRefs.current.set(index, node); else blockRefs.current.delete(index) }} style={{ display: 'flex', justifyContent: 'center', paddingTop: index === 0 ? 0 : blockGap(blocks[index - 1]!, body) }}><div style={{ display: 'flex', flexDirection: 'column', width: docWidth }}>
            {active === index && !deleted ? <>
              <DecoratedTextarea decorations={markdownInputDecorations(body, noteInputMarkColors(t))} ref={bodyRef} testId={`note-block-input-${index}`} aria-label="Edit block" autoFocus value={body} minRows={2} maxRows={30} onChange={(e) => { update(index, e.value ?? ''); setSlashIndex(0) }} onBlur={() => void session.flush()} onKeyDown={(e) => {
                if (e.key === 'escape' || (e.key === 'enter' && e.modifiers?.cmd)) finish()
                if (slashItems.length && e.key === 'down') setSlashIndex((value) => (value + 1) % slashItems.length)
                if (slashItems.length && e.key === 'up') setSlashIndex((value) => (value - 1 + slashItems.length) % slashItems.length)
                if (slashItems.length && e.key === 'enter') format(slashItems[slashIndex % slashItems.length]!.id)
              }} theme={{ text: k.fg1, caret: k.fg }} style={{ width: '100%', fontSize: READ, lineHeight: READ * 1.6, color: k.fg1, backgroundColor: t.surface }} />
              {slash && slashItems.length > 0 && <div testId="note-slash-menu" style={{ display: 'flex', flexDirection: 'column', width: 240, padding: 6, borderRadius: 10, borderWidth: 1, borderColor: t.border, backgroundColor: t.popover }}>{slashItems.map((b, i) => <div key={b.id} testId={`note-slash-${b.id}`} onClick={() => format(b.id)} style={{ padding: 7, borderRadius: 6, backgroundColor: i === slashIndex ? t.hover : undefined, cursor: 'pointer' }}><Label color={t.text} size={13}>{b.label}</Label></div>)}</div>}
            </> : <div testId={`note-block-${index}`} tabIndex={deleted ? -1 : 0} onClick={() => { if (!deleted) setActive(index) }} onKeyDown={(e) => { if (!deleted && e.key === 'enter') setActive(index) }} style={{ cursor: deleted ? 'default' : 'text' }}><NoteBlock width={docWidth} body={body} noteId={id} tasks={allTasks} /></div>}
          </div></div>)}
          <div key="append" style={{ display: 'flex', justifyContent: 'center', paddingTop: 24, paddingBottom: 48, minHeight: 96 }}>{!deleted && <div testId="note-add-block" style={{ width: '100%', minHeight: 48, cursor: 'text' }} onClick={() => { const next = [...blocks]; if (next[next.length - 1]?.trim()) { next[next.length - 1] = next[next.length - 1]!.replace(/\n*$/, '\n\n'); next.push('') }; setBlocks(next); session.edit({ body: next.join('') }); setActive(next.length - 1) }} />}</div>
        </virtual-list>
        {outline && size.width >= 1050 && headings.length > 0 && <div style={{ display: 'flex', flexDirection: 'column', position: 'absolute', left: 24, top: 84, width: 188 }}>
          <div style={{ marginBottom: 6 }}><Label color={k.fg3} size={NOTES_META} lineHeight={18}>Outline</Label></div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, position: 'relative' }}>
            {headings.map((h, i) => <div key={h.index} testId={`note-outline-${h.index}`} onClick={() => { if (list.current) renderer?.scrollToItem?.(list.current.id, h.index + 1, (h.index === 0 ? 0 : blockGap(blocks[h.index - 1]!, blocks[h.index]!)) - 96); setOutlineActive(i) }} style={{ display: 'flex', alignItems: 'center', height: 24, paddingTop: 4, paddingBottom: 4, paddingLeft: 9 + Math.min(2, h.level - minimumHeadingLevel) * 10, borderLeftWidth: 1, borderColor: k.hair, cursor: 'pointer' }}><Label color={i === activeOutlineIndex ? k.fg : k.fg3} size={NOTES_META} lineHeight={16} truncate style={{ pointerEvents: 'none' }}>{h.text}</Label></div>)}
            <motion.div testId={`note-outline-active-${headings[activeOutlineIndex]?.index ?? 0}`} initial={false} animate={{ translateY: activeOutlineIndex * 26 }} transition={{ duration: REDUCED_MOTION || getNav().keyboardNav ? 0 : 0.12, ease: EASE_OUT }} style={{ position: 'absolute', left: 0, top: 0, width: 2, height: 24, backgroundColor: k.fg2, pointerEvents: 'none' }} />
          </div>
        </div>}
        {!deleted && <div style={{ position: 'absolute', top: 14, left: 0, right: 0, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}><div style={{ pointerEvents: 'auto' }}>
          <Toolbar blockLabel={blockLabel(blocks[active ?? 0] ?? '')} outlineOn={outline} image={() => void insertImage()} disabled={deleted} active={active !== null} format={format} mark={mark} finish={finish} toggleOutline={() => display({ outline: !outline })} link={(label, href) => {
            const at = active ?? Math.max(0, blocks.length - 1)
            const raw = blocks[at] ?? ''
            const text = label.replace(/[\\[\]]/g, '\\$&')
            update(at, `${raw.trimEnd()}${raw.trim() ? ' ' : ''}[${text}](${href.replaceAll(' ', '%20').replaceAll('(', '%28').replaceAll(')', '%29')})\n\n`)
            setActive(at)
          }} />
        </div></div>}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 20, height: 40, paddingLeft: 20, paddingRight: 20, flexShrink: 0 }}>
        {tasks.length > 0 && <>
          <Label color={k.fg3} size={NOTES_META} lineHeight={19.5}>Linked tasks</Label>
          {[...tasks].sort((a, b) => LIST_STATUS_ORDER.indexOf(a.status) - LIST_STATUS_ORDER.indexOf(b.status) || a.rank - b.rank).slice(0, 4).map((task) => <div key={task.id} testId={`note-task-${task.id}`} onClick={() => { openTask(task.id); goPage('tasks') }} style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: -5, marginRight: -5, paddingTop: 3, paddingBottom: 3, paddingLeft: 5, paddingRight: 5, borderRadius: 6, cursor: 'pointer', hover: { backgroundColor: k.hover } }}>
            <StatusGlyph status={task.status} /><Label color={k.fg2} size={NOTES_META} lineHeight={19.5}>{task.key}</Label><Label color={k.fg3} size={NOTES_META} lineHeight={19.5}>{STATUS_LABEL[task.status]}</Label></div>)}
          {tasks.length > 4 && <Label color={k.fg3} size={NOTES_META}>{`${tasks.length - 4} more`}</Label>}
        </>}
        <div style={{ flexGrow: 1 }} /><Label color={k.fg3} size={NOTES_META} lineHeight={19.5}>{wordCountLabel(countWords(plainText(snap.body)))}</Label>
      </div>
    </>}
  </div>
}
function Banner({ title, detail, children }: { title: string; detail: string; children: React.ReactNode }) { const t = useTheme(); return <div testId="note-banner" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 14, backgroundColor: t.buttonSecondary }}><div style={{ display: 'flex', flexDirection: 'column', gap: 4, flexGrow: 1 }}><Label color={t.text} size={13} weight={500}>{title}</Label><Label color={t.textSecondary} size={12}>{detail}</Label></div>{children}</div> }
