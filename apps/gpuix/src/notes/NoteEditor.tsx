import { spawn } from 'node:child_process'
import { useGpuix, useWindowSize, type PublicInstance } from '@gpuix/react'
import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { editedAgo } from '@/state/notesModel'
import type { TaskItem } from '../../../../packages/kybern-client/src/types.ts'
import { addWindowKeyHandler } from '../nav/keys.ts'
import { getNav } from '../nav/store.ts'
import { openThread } from '../nav/history.ts'
import { Button } from '../settings/controls.tsx'
import { onWindowVisibility } from '../native/visibility.ts'
import { useApp } from '../state.ts'
import { Label, useTheme } from '../ui.tsx'
import { cachedMarkdownTheme } from '../transcript/kit.tsx'
import { display, gallery, getNotes, restoreNote, rpc, useNotes } from './store.ts'
import { noteSession } from './session.ts'
import { BLOCKS, formatBlock, splitBlocks } from './blocks.ts'
import { NoteMenu } from './NoteMenu.tsx'
import { Toolbar } from './Toolbar.tsx'

export function openLink(href: string) {
  const thread = /^kybern:\/\/thread\/([a-f\d-]{36})\/?$/i.exec(href)
  if (thread) { openThread(thread[1]!); return }
  if (/^(https?:|mailto:|tel:)/i.test(href)) { const child = spawn('open', [href], { stdio: 'ignore' }); child.on('error', () => {}) }
}
export function NoteEditor({ id }: { id: string }) {
  const t = useTheme()
  const { renderer } = useGpuix()
  const size = useWindowSize({ intervalMs: 300 })
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
  if (epoch !== snap.epoch) { setEpoch(snap.epoch); setBlocks(splitBlocks(snap.body)) }
  useEffect(() => { session.attach(); const off = onWindowVisibility((visible) => { if (!visible) void session.flush() }); return () => { off(); session.detach() } }, [session])
  useEffect(() => {
    let live = true
    const refresh = () => { void rpc().call('tasks.items.list', {}).then((r) => { if (live) setTasks(r.tasks) }).catch(() => {}) }
    refresh()
    const off = rpc().onNotification('tasks.items.changed', refresh)
    return () => { live = false; off() }
  }, [id])
  useEffect(() => addWindowKeyHandler((e) => {
    if (getNav().paletteOpen || getNav().settingsOpen || getNotes().quick || getNotes().capture) return
    if (e.modifiers?.cmd && e.key === 's') { void session.flush(); return true }
    if (e.key === 'escape' && active === null) { gallery(); return true }
  }), [session, active])
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
  const headings = blocks.flatMap((body, index) => { const match = /^(#{1,6})\s+(.+)/.exec(body); return match ? [{ index, level: match[1]!.length, text: match[2]! }] : [] }).slice(0, 80)
  const slash = active !== null && /^\/[\w ]*$/.test(blocks[active] ?? '')
  const slashItems = slash ? BLOCKS.filter((b) => b.label.toLowerCase().includes((blocks[active!] ?? '').slice(1).toLowerCase())) : []
  const note = summary ?? snap.note
  const deleted = !!(summary ? summary.deleted_at : snap.note?.deleted_at)
  const status = snap.status === 'saved' ? (note ? editedAgo(note.updated_at) : 'Saved') : snap.status === 'dirty' ? 'Unsaved changes' : snap.status === 'saving' ? 'Saving…' : snap.status === 'conflict' ? 'Choose a version' : 'Couldn’t save · Retry'
  return <div testId="note-editor" style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, height: 44, paddingLeft: 16, paddingRight: 16, flexShrink: 0 }}>
      <Button testId="notes-back" onClick={gallery}>‹ Notes</Button><Label color={t.textSecondary}>/</Label><Label color={t.text} size={13} truncate style={{ flexGrow: 1 }}>{snap.title || 'Untitled'}</Label>
      {note && <NoteMenu note={note} readText={() => ({ title: snap.title, body: snap.body })} />}
    </div>
    {snap.phase === 'error' && <Banner title="Couldn’t open this note" detail={snap.error ?? ''}><Button onClick={() => void session.reload()}>Try again</Button></Banner>}
    {snap.phase === 'missing' && <Banner title="This note no longer exists" detail="Return to Notes to open another document."><Button onClick={gallery}>Open Notes</Button></Banner>}
    {snap.conflict && <Banner title="This note changed on another device" detail="Keep your version to replace theirs, or use theirs and discard your changes."><Button testId="note-use-theirs" onClick={() => session.useTheirs()}>Use theirs</Button><Button testId="note-keep-mine" onClick={() => session.keepMine()}>Keep mine</Button></Banner>}
    {deleted && <Banner title="This note is in Recently deleted" detail="Restore it to edit it again."><Button testId="note-restore" onClick={() => void restoreNote(id)}>Restore</Button></Banner>}
    {snap.phase === 'ready' && <>
      <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 8, paddingBottom: 12, flexShrink: 0 }}>
        <Toolbar disabled={deleted} active={active !== null} format={format} mark={mark} finish={finish} toggleOutline={() => display({ outline: !outline })} link={(label, href) => {
          const at = active ?? Math.max(0, blocks.length - 1)
          const raw = blocks[at] ?? ''
          const text = label.replace(/[\\[\]]/g, '\\$&')
          update(at, `${raw.trimEnd()}${raw.trim() ? ' ' : ''}[${text}](${href.replaceAll(' ', '%20').replaceAll('(', '%28').replaceAll(')', '%29')})\n\n`)
          setActive(at)
        }} />
      </div>
      <div style={{ display: 'flex', flexGrow: 1, minHeight: 0, position: 'relative' }}>
        {outline && size.width >= 1050 && <div style={{ display: 'flex', flexDirection: 'column', position: 'absolute', left: 24, top: 56, width: Math.max(130, (size.width - 62 - 640) / 2 - 48), gap: 12 }}><Label color={t.textSecondary} size={11}>ON THIS PAGE</Label>{headings.map((h) => <div key={h.index} testId={`note-outline-${h.index}`} onClick={() => { if (list.current) renderer?.scrollToItem?.(list.current.id, h.index + 1) }} style={{ paddingLeft: (h.level - 1) * 8, cursor: 'pointer' }}><Label color={t.textSecondary} size={12} truncate>{h.text}</Label></div>)}</div>}
        <virtual-list ref={list} testId="note-body-list" style={{ flexGrow: 1, minHeight: 0 }}>
          <div key="heading" style={{ display: 'flex', justifyContent: 'center', paddingLeft: 32, paddingRight: 32, paddingTop: 38, paddingBottom: 14 }}><div style={{ display: 'flex', flexDirection: 'column', width: '100%', maxWidth: 640, gap: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Label color={t.textSecondary} size={12}>{note?.scope === 'global' ? 'Global' : projects.find((p) => p.id === note?.project_id)?.name ?? 'Chats'}</Label><Label color={t.textSecondary} size={12}>·</Label><div testId="note-save-status" onClick={() => { if (snap.status === 'error') void session.flush() }}><Label color={snap.status === 'error' ? t.red : t.textSecondary} size={12}>{status}</Label></div></div>
            <input testId="note-title" autoFocus={!snap.title && !snap.body && !deleted} aria-label="Title" value={snap.title} placeholder="Untitled" readOnly={deleted || note?.scope === 'thread'} onChange={(e) => session.edit({ title: (e.value ?? '').replace(/\s*\n\s*/g, ' ').slice(0, 300) })} onBlur={() => void session.flush()} onSubmit={() => setActive(0)} theme={{ text: t.text, caret: t.text }} style={{ width: '100%', height: 42, fontSize: 28, fontWeight: 600, color: t.text, backgroundColor: t.surface }} />
          </div></div>
          {blocks.map((body, index) => <div key={`${epoch}:${index}`} style={{ display: 'flex', justifyContent: 'center', paddingLeft: 32, paddingRight: 32, paddingBottom: 10 }}><div style={{ display: 'flex', flexDirection: 'column', width: '100%', maxWidth: 640 }}>
            {active === index && !deleted ? <>
              <textarea ref={bodyRef} testId={`note-block-input-${index}`} aria-label="Edit block" autoFocus value={body} minRows={2} maxRows={30} onChange={(e) => { update(index, e.value ?? ''); setSlashIndex(0) }} onBlur={() => void session.flush()} onKeyDown={(e) => {
                if (e.key === 'escape' || (e.key === 'enter' && e.modifiers?.cmd)) finish()
                if (slashItems.length && e.key === 'down') setSlashIndex((value) => (value + 1) % slashItems.length)
                if (slashItems.length && e.key === 'up') setSlashIndex((value) => (value - 1 + slashItems.length) % slashItems.length)
                if (slashItems.length && e.key === 'enter') format(slashItems[slashIndex % slashItems.length]!.id)
              }} theme={{ text: t.text, caret: t.text }} style={{ width: '100%', fontSize: /^#{1,3} /.test(body) ? 20 : 15, lineHeight: 25, color: t.text, backgroundColor: t.surface }} />
              {slash && slashItems.length > 0 && <div testId="note-slash-menu" style={{ display: 'flex', flexDirection: 'column', width: 240, padding: 6, borderRadius: 10, borderWidth: 1, borderColor: t.border, backgroundColor: t.popover }}>{slashItems.map((b, i) => <div key={b.id} testId={`note-slash-${b.id}`} onClick={() => format(b.id)} style={{ padding: 7, borderRadius: 6, backgroundColor: i === slashIndex ? t.hover : undefined, cursor: 'pointer' }}><Label color={t.text} size={13}>{b.label}</Label></div>)}</div>}
            </> : <div testId={`note-block-${index}`} tabIndex={deleted ? -1 : 0} onClick={() => { if (!deleted) setActive(index) }} onKeyDown={(e) => { if (!deleted && e.key === 'enter') setActive(index) }} style={{ minHeight: 28, cursor: deleted ? 'default' : 'text' }}><NativeBlock body={body} /></div>}
          </div></div>)}
          <div key="append" style={{ display: 'flex', justifyContent: 'center', padding: 32, minHeight: 120 }}>{!deleted && <Button testId="note-add-block" onClick={() => { const next = [...blocks]; if (next[next.length - 1]?.trim()) { next[next.length - 1] = next[next.length - 1]!.replace(/\n*$/, '\n\n'); next.push('') }; setBlocks(next); session.edit({ body: next.join('') }); setActive(next.length - 1) }}>Continue writing</Button>}</div>
        </virtual-list>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingLeft: 24, paddingRight: 24, height: 38, borderTopWidth: 0.5, borderColor: t.border, flexShrink: 0 }}>
        {tasks.slice(0, 5).map((task) => <div key={task.id} testId={`note-task-${task.id}`} style={{ display: 'flex', padding: 5, borderRadius: 6, backgroundColor: t.buttonSecondary }}><Label color={t.textSecondary} size={11}>{`${task.key} · ${task.status.replaceAll('_', ' ')}`}</Label></div>)}
        <Label color={t.textSecondary} size={11} style={{ flexGrow: 1 }}>{active !== null ? 'Formatting applies to this block.  ⌘ ↵ Done' : ''}</Label><Label color={t.textSecondary} size={11}>{`${snap.body.trim() ? snap.body.trim().split(/\s+/).length : 0} words`}</Label>
      </div>
    </>}
  </div>
}
const NativeBlock = memo(function NativeBlock({ body }: { body: string }) { const t = useTheme(); const theme = useMemo(() => { const base = cachedMarkdownTheme(t); return { ...base, metrics: { ...base.metrics, mdTextSize: 15, mdLineHeight: 25, mdHeadingSizes: [24, 21, 17, 15] } } }, [t]); return body.trim() ? <markdown source={body} theme={theme} onLinkClick={(e) => { if (e.value) openLink(e.value) }} style={{ color: t.text, userSelect: 'text' }} /> : <Label color={t.textSecondary} size={15}>Start writing, or type / for blocks…</Label> })
function Banner({ title, detail, children }: { title: string; detail: string; children: React.ReactNode }) { const t = useTheme(); return <div testId="note-banner" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 14, backgroundColor: t.buttonSecondary }}><div style={{ display: 'flex', flexDirection: 'column', gap: 4, flexGrow: 1 }}><Label color={t.text} size={13} weight={500}>{title}</Label><Label color={t.textSecondary} size={12}>{detail}</Label></div>{children}</div> }
