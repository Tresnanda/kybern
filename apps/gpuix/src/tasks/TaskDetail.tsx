import { useEffect, useMemo, useRef, useState } from 'react'
import { useWindowSize } from '@gpuix/react'
import { relativeTime } from '@/lib/format'
import { Icon } from '../icons.tsx'
import { N } from '../nav/glyphs.ts'
import { useSidebarWidth } from '../shell/layout.ts'
import { notesTokens } from '../notes/kit.tsx'
import { setDetailSequence } from './Header.tsx'
import { composeTaskBody, type Criterion, latestRun, runOutcome, splitTaskBody, STATUS_LABEL, taskActivity } from '@/state/tasksModel'
import type { Note, TaskItem } from '../../../../packages/kybern-client/src/types.ts'
import { getClient } from '../state.ts'
import { openThread } from '../nav/history.ts'
import { Menu, MenuItem } from '../nav/overlay.tsx'
import { useNotes, rpc as noteRpc } from '../notes/store.ts'
import { openLink } from '../notes/NoteEditor.tsx'
import { Button } from '../settings/controls.tsx'
import { CriterionRow, DescriptionEditor, TitleField } from './Content.tsx'
import { ink, Label, ProviderMark, useTheme } from '../ui.tsx'
import { cachedMarkdownTheme } from '../transcript/kit.tsx'
import { Check } from './Glyphs.tsx'
import { MoreMenu, ProjectMenu, TaskMenus } from './TaskMenus.tsx'
import { useTaskAutosave } from './autosave.ts'
import { openTask, taskTyping, setTasks, updateTask } from './store.ts'


export function TaskDetail({ task, sequence }: { task: TaskItem; sequence: string[] }) {
  const t = useTheme()
  // `.tk-desc .note-prose`: 15/24 prose at 86% ink, inline code at 0.833em.
  const descTheme = useMemo(() => { const base = cachedMarkdownTheme(t); return { ...base, text: t.variant === 'dark' ? 'rgba(252, 252, 252, 0.86)' : 'rgba(13, 13, 13, 0.86)', metrics: { ...base.metrics, mdTextSize: 15, mdLineHeight: 24, codeTextSize: 12.5 } } }, [t])
  const availableNotes = useNotes((s) => s.notes)
  const [editing, setEditing] = useState(false)
  const edit = useTaskAutosave(task)
  // The description and criteria are edited as local text and composed into the body (empty criteria are kept until the row is left).
  const [description, setDescription] = useState(() => splitTaskBody(edit.body).description)
  const [criteria, setCriteria] = useState<Criterion[]>(() => splitTaskBody(edit.body).criteria)
  const [focusRow, setFocusRow] = useState<{ index: number; token: number } | null>(null)
  const lastBody = useRef(edit.body)
  // A body that arrived from elsewhere (and not from these edits) replaces what is shown, unless the description is being typed in.
  useEffect(() => {
    if (edit.body === lastBody.current) return
    lastBody.current = edit.body
    const next = splitTaskBody(edit.body)
    setCriteria(next.criteria)
    if (!editing) setDescription(next.description)
  }, [edit.body])
  const changeDescription = (value: string) => { setDescription(value); lastBody.current = composeTaskBody(value, criteria); edit.editBody(lastBody.current) }
  const changeCriteria = (next: Criterion[], persist: boolean) => {
    setCriteria(next)
    lastBody.current = composeTaskBody(description, next)
    if (lastBody.current !== edit.body) edit.editBody(lastBody.current)
    if (persist) void edit.flush()
  }
  const [notes, setNotes] = useState<(Note | { id: string; title: string; body: string })[]>([])
  const [expandedNote, setExpandedNote] = useState<string | null>(null)
  const run = latestRun(task)
  const at = sequence.indexOf(task.id)
  useEffect(() => () => taskTyping(false), [])
  const noteKey = task.note_ids.join(',')
  useEffect(() => {
    let live = true
    void Promise.all(
      task.note_ids.map(async (id) => {
        try {
          const result = await getClient()!.call('notes.get', { id })
          return result.note ?? { id, title: 'Note unavailable', body: '' }
        } catch {
          return { id, title: 'Unable to load note', body: 'Reconnect and reopen this task to try again.' }
        }
      }),
    ).then((value) => {
      if (live) setNotes(value)
    })
    return () => {
      live = false
    }
  }, [noteKey])
  const beginEdit = () => setEditing(true)
  const size = useWindowSize({ intervalMs: 300 })
  const sidebar = useSidebarWidth()
  // `.tk-dcol`: 620px, or the main column less 24px each side; the side panel is 296px.
  const sidePanel = size.width - 52 - sidebar - 8 >= 760 ? 296 : 0
  const main = size.width - 52 - sidebar - 8 - sidePanel
  const gutter = Math.max(24, (main - 620) / 2)
  const padding = { paddingLeft: gutter, paddingRight: gutter, paddingBottom: 0 }
  const k = notesTokens(t)
  useEffect(() => { setDetailSequence(sequence) }, [sequence.join(',')])
  return (
    <>
      <div style={{ display: 'flex', flexGrow: 1, minHeight: 0, position: 'relative' }}>
        <virtual-list testId="task-detail" style={{ flexGrow: 1, minWidth: 0, minHeight: 0 }}>
          <div key="content" style={{ ...padding, paddingTop: 48, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <TitleField value={edit.title} saved={task.title} onChange={edit.editTitle} onCommit={() => void edit.flush()} onEnter={() => setEditing(true)} />
            {editing ? (
              <DescriptionEditor value={description} onChange={changeDescription} onCommit={() => void edit.flush()} onExit={() => setEditing(false)} />
            ) : (
              <div testId="task-desc" onClick={() => setEditing(true)} style={{ display: 'flex', flexDirection: 'column', minHeight: 24, cursor: 'text' }}>
                {description.trim() ? (
                  <markdown
                    theme={descTheme}
                    source={description}
                    onLinkClick={(e) => { if (e.value) openLink(e.value) }}
                    style={{ color: ink(t, 0.86), fontSize: 15, userSelect: 'text' }}
                  />
                ) : (
                  <Label color={k.fg3} size={15} lineHeight={24}>Add a description…</Label>
                )}
              </div>
            )}
            {edit.conflict && <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Label color={t.red} size={12}>This task changed elsewhere.</Label><Button testId="task-use-theirs" onClick={edit.useTheirs}>Use theirs</Button><Button testId="task-keep-mine" onClick={edit.keepMine}>Keep mine</Button></div>}
            {edit.error && !edit.conflict && <Label color={t.red} size={12}>{edit.error}</Label>}
          </div>
          <div key="criteria-title" style={{ ...padding, paddingTop: 36, paddingBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Label color={t.text} size={13} lineHeight={19.5} weight={600}>Acceptance criteria</Label>
            {criteria.length > 0 && <Label color={k.fg3} size={13} lineHeight={19.5}>{`${criteria.filter((c) => c.checked).length} of ${criteria.length}`}</Label>}
          </div>
          {criteria.map((criterion, index) => (
            <div key={`criterion-${index}`} style={padding}>
              <CriterionRow
                index={index}
                text={criterion.text}
                checked={criterion.checked}
                focusNow={focusRow?.index === index}
                focusToken={focusRow?.token ?? 0}
                onToggle={() => changeCriteria(criteria.map((c, i) => (i === index ? { ...c, checked: !c.checked } : c)), true)}
                onText={(text) => changeCriteria(criteria.map((c, i) => (i === index ? { ...c, text } : c)), false)}
                onEnter={() => { changeCriteria([...criteria.slice(0, index + 1), { checked: false, text: '' }, ...criteria.slice(index + 1)], false); setFocusRow({ index: index + 1, token: Date.now() }) }}
                onBackspaceEmpty={() => { changeCriteria(criteria.filter((_, i) => i !== index), true); setFocusRow({ index: Math.max(0, index - 1), token: Date.now() }) }}
                onBlur={() => changeCriteria(criteria.filter((c) => c.text.trim() || c.extra?.length), true)}
              />
            </div>
          ))}
          <div key="add-criterion" style={padding}>
            <div testId="task-add-criterion" onClick={() => { changeCriteria([...criteria, { checked: false, text: '' }], false); setFocusRow({ index: criteria.length, token: Date.now() }) }} style={{ display: 'flex', alignItems: 'center', gap: 8, height: 32, marginLeft: -8, marginRight: -8, paddingLeft: 8, paddingRight: 8, borderRadius: 7, cursor: 'pointer', hover: { backgroundColor: ink(t, 0.05) } }}>
              <Icon source={N.plus} size={14} color={k.fg3} /><Label color={k.fg3} size={13} lineHeight={19.5}>Add a criterion</Label>
            </div>
          </div>
          <div key="notes-title" style={{ ...padding, paddingTop: 36, paddingBottom: 8, display: 'flex', alignItems: 'center' }}>
            <Label color={t.text} size={13} lineHeight={19.5} weight={600}>Linked notes</Label>
          </div>
          {notes.map((note) => (
            <div key={note.id} style={{ ...padding }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, height: 34, marginLeft: -8, marginRight: -8, paddingLeft: 8, paddingRight: 8, borderRadius: 7, hover: { backgroundColor: ink(t, 0.05) } }}>
                <div onClick={() => setExpandedNote(expandedNote === note.id ? null : note.id)} style={{ display: 'flex', alignItems: 'center', gap: 10, flexGrow: 1, minWidth: 0, cursor: 'pointer' }}><Icon source={N.note} size={14} color={k.fg3} /><Label color={k.fg1} size={13} lineHeight={19.5} truncate>{note.title || 'Untitled note'}</Label></div>
                <div testId={`task-detach-${note.id}`} onClick={() => void updateTask(task.id, { note_ids: task.note_ids.filter((id) => id !== note.id) }).catch(() => {})} style={{ cursor: 'pointer' }}><Label color={k.fg3} size={12}>Remove link</Label></div>
              </div>
              {expandedNote === note.id && (
                <markdown theme={cachedMarkdownTheme(t)} source={note.body} style={{ color: t.text, userSelect: 'text' }} />
              )}
            </div>
          ))}
          <div key="link-note" style={padding}>
            <Menu testId="task-attach-note" trigger={() => <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 32, marginLeft: -8, marginRight: -8, paddingLeft: 8, paddingRight: 8, borderRadius: 7, pointerEvents: 'none', hover: { backgroundColor: ink(t, 0.05) } }}><Icon source={N.plus} size={14} color={k.fg3} /><Label color={k.fg3} size={13} lineHeight={19.5}>Link a note</Label></div>}>
              {availableNotes.filter((note) => !note.deleted_at && !task.note_ids.includes(note.id) && noteRpc(note.id) === getClient()).map((note) => <MenuItem key={note.id} id={note.id} testId={`task-attach-${note.id}`} label={note.title || 'Untitled'} onSelect={() => void updateTask(task.id, { note_ids: [...task.note_ids, note.id] }).catch(() => {})} />)}
            </Menu>
          </div>
          <div key="activity-title" style={{ ...padding, paddingTop: 36, paddingBottom: 8 }}>
            <Label color={t.text} size={13} lineHeight={19.5} weight={600}>Activity</Label>
          </div>
          {taskActivity(task).map((event, index) => (
            <div key={`activity-${index}`} style={{ ...padding }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, height: 32, paddingTop: 7, paddingBottom: 7 }}>
                <Icon source={N.plus} size={14} color={k.fg3} />
                <Label color={k.fg2} size={13} lineHeight={18} style={{ flexGrow: 1 }}>
                  {event.kind === 'created' ? 'Created' : event.kind === 'status' ? `Changed status to ${STATUS_LABEL[event.status]}` : `Run ${event.run.number} · ${runOutcome(event.run, Date.now())}`}
                </Label>
                {event.kind === 'run' && <div onClick={() => openThread(event.run.thread_id)} style={{ cursor: 'pointer' }}><Label color={k.fg1} size={12} weight={500}>Open run</Label></div>}
                <Label color={k.fg3} size={12} lineHeight={18}>{relativeTime(event.at, Date.now()).replace(/^(\d+[smhd])$/, '$1 ago')}</Label>
              </div>
            </div>
          ))}
          <div key="dock-room" style={{ height: 140 }} />
        </virtual-list>
        {sidePanel > 0 && <div style={{ display: 'flex', flexDirection: 'column', width: sidePanel, flexShrink: 0, padding: 20, borderLeftWidth: 1, borderColor: k.hair }}>
          {[['Status', <TaskMenus key="s" ids={[task.id]} property="status" value />], ['Priority', <TaskMenus key="p" ids={[task.id]} property="priority" value />], ['Project', <ProjectMenu key="j" task={task} value />]].map(([label, node]) => <div key={label as string} style={{ display: 'flex', alignItems: 'center', minHeight: 34 }}><div style={{ width: 76, flexShrink: 0 }}><Label color={k.fg3} size={12} lineHeight={18}>{label as string}</Label></div>{node}</div>)}
        </div>}
        <div style={{ position: 'absolute', left: 16, right: sidePanel + 16, bottom: 16, display: 'flex', justifyContent: 'center' }}>
          <div testId="task-send-open" onClick={() => setTasks({ composer: [task.id] })} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', maxWidth: 652, height: 44, paddingLeft: 12, paddingRight: 12, borderRadius: 12, backgroundColor: ink(t, t.variant === 'dark' ? 0.05 : 0.04), cursor: 'pointer', hover: { backgroundColor: ink(t, 0.07) } }}>
            <ProviderMark kind="claude-code" size={14} />
            <Label color={k.fg3} size={13} lineHeight={19.5} style={{ flexGrow: 1 }}>{`Tell an agent what to do with ${task.key}…`}</Label>
            <Label color={k.fg4} size={12}>⌘↵</Label>
          </div>
        </div>
      </div>
    </>
  )
}
