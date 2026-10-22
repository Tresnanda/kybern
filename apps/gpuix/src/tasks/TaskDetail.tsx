import { useEffect, useRef, useState } from 'react'
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
import { Button } from '../kit/Button.tsx'
import { CriterionRow, DescriptionEditor, TitleField } from './Content.tsx'
import { ink, Label, ProviderMark, useTheme } from '../ui.tsx'
import { cachedMarkdownTheme } from '../transcript/kit.tsx'
import { MoreMenu, ProjectMenu, TaskMenus } from './TaskMenus.tsx'
import { useTaskAutosave } from './autosave.ts'
import { TaskDock } from './TaskDock.tsx'
import { useGlass } from '../platform/glass.ts'
import { EDGE_FADE } from '../native/local-build.ts'
import { openTask, taskState, taskTyping, setTasks, updateTask } from './store.ts'


export function TaskDetail({ task, sequence }: { task: TaskItem; sequence: string[] }) {
  const t = useTheme()
  const g = useGlass()
  const availableNotes = useNotes((s) => s.notes)
  const [editing, setEditing] = useState(false)
  const edit = useTaskAutosave(task)
  // The description and criteria are edited as local text and composed into the body (empty criteria are kept until the row is left).
  const [description, setDescription] = useState(() => splitTaskBody(edit.body).description)
  // Bumped when the description is replaced from elsewhere; typing never bumps it.
  const [descriptionEpoch, setDescriptionEpoch] = useState(0)
  const [criteria, setCriteria] = useState<Criterion[]>(() => splitTaskBody(edit.body).criteria)
  const [focusRow, setFocusRow] = useState<{ index: number; token: number } | null>(null)
  const lastBody = useRef(edit.body)
  // A body that arrived from elsewhere (and not from these edits) replaces what is shown, unless the description is being typed in.
  useEffect(() => {
    if (edit.body === lastBody.current) return
    lastBody.current = edit.body
    const next = splitTaskBody(edit.body)
    setCriteria(next.criteria)
    if (!editing && next.description !== description) { setDescription(next.description); setDescriptionEpoch(e => e + 1) }
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
  // The floating dock's height: the list ends that far above its own end, so the last row scrolls clear (`--tk-dock-h`).
  const [dockHeight, setDockHeight] = useState(88)
  // Whether the open composer holds no draft: a click on the page then tucks it away.
  const composerEmpty = useRef(true)
  useEffect(() => { setDetailSequence(sequence) }, [sequence.join(',')])
  return (
    <>
      <div style={{ display: 'flex', flexGrow: 1, minHeight: 0, position: 'relative' }}>
        {/* Whole-window glass has no colour to hide rows behind the dock with, so the list ends at the dock's top (`dockHeight`, measured).
            Elsewhere it ends 1px above the dock's end: at a fractional page edge the list's clip rounded outward and its last pixel row showed under the dock. */}
        <div onMouseDown={() => { if (taskState().composer && composerEmpty.current) setTasks({ composer: null }) }} style={{ display: 'flex', flexGrow: 1, minWidth: 0, minHeight: 0, marginBottom: g.on ? dockHeight : 1, overflow: 'hidden' }} edgeFade={g.on && EDGE_FADE ? { bottom: 24 } : undefined}>
        <virtual-list testId="task-detail" style={{ flexGrow: 1, minWidth: 0, minHeight: 0 }}>
          <div key="content" style={{ ...padding, paddingTop: 48, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <TitleField value={edit.title} saved={task.title} onChange={edit.editTitle} onCommit={() => void edit.flush()} onEnter={() => setEditing(true)} />
            <DescriptionEditor value={description} epoch={descriptionEpoch} onChange={changeDescription} onCommit={() => void edit.flush()} onExit={() => setEditing(false)} onFocus={beginEdit} focus={editing} />
            {edit.conflict && <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Label color={t.red} size={12}>This task changed elsewhere.</Label><Button testId="task-use-theirs" size="sm" onClick={edit.useTheirs}>Use theirs</Button><Button testId="task-keep-mine" size="sm" onClick={edit.keepMine}>Keep mine</Button></div>}
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
          <div key="add-criterion" style={{ ...padding, display: 'flex', alignItems: 'center' }}>
            <Button testId="task-add-criterion" variant="ghost" size="sm" icon="plus" onClick={() => { changeCriteria([...criteria, { checked: false, text: '' }], false); setFocusRow({ index: criteria.length, token: Date.now() }) }}>Add a criterion</Button>
          </div>
          <div key="notes-title" style={{ ...padding, paddingTop: 36, paddingBottom: 8, display: 'flex', alignItems: 'center' }}>
            <Label color={t.text} size={13} lineHeight={19.5} weight={600}>Linked notes</Label>
          </div>
          {notes.map((note) => (
            <div key={note.id} style={{ ...padding }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, height: 34, marginLeft: -8, marginRight: -8, paddingLeft: 8, paddingRight: 8, borderRadius: 7, hover: { backgroundColor: ink(t, 0.05) } }}>
                <div onClick={() => setExpandedNote(expandedNote === note.id ? null : note.id)} style={{ display: 'flex', alignItems: 'center', gap: 10, flexGrow: 1, minWidth: 0, cursor: 'pointer' }}><Icon source={N.note} size={14} color={k.fg3} /><Label color={k.fg1} size={13} lineHeight={19.5} truncate>{note.title || 'Untitled note'}</Label></div>
                <Button testId={`task-detach-${note.id}`} variant="ghost" size="sm" onClick={() => void updateTask(task.id, { note_ids: task.note_ids.filter((id) => id !== note.id) }).catch(() => {})}>Remove link</Button>
              </div>
              {expandedNote === note.id && (
                <markdown theme={cachedMarkdownTheme(t)} source={note.body} style={{ color: t.text, userSelect: 'text' }} />
              )}
            </div>
          ))}
          <div key="link-note" style={padding}>
            <Menu testId="task-attach-note" trigger={() => <Button variant="ghost" size="sm" icon="plus">Link a note</Button>}>
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
                {event.kind === 'run' && <Button variant="ghost" size="sm" onClick={() => openThread(event.run.thread_id)}>Open run</Button>}
                <Label color={k.fg3} size={12} lineHeight={18}>{relativeTime(event.at, Date.now()).replace(/^(\d+[smhd])$/, '$1 ago')}</Label>
              </div>
            </div>
          ))}
          <div key="dock-room" style={{ height: Math.max(140, dockHeight + 32) }} />
        </virtual-list>
        </div>
        {sidePanel > 0 && <div style={{ display: 'flex', flexDirection: 'column', width: sidePanel, flexShrink: 0, padding: 20, borderLeftWidth: 1, borderColor: k.hair }}>
          {[['Status', <TaskMenus key="s" ids={[task.id]} property="status" value />], ['Priority', <TaskMenus key="p" ids={[task.id]} property="priority" value />], ['Project', <ProjectMenu key="j" task={task} value />]].map(([label, node]) => <div key={label as string} style={{ display: 'flex', alignItems: 'center', minHeight: 34 }}><div style={{ width: 76, flexShrink: 0 }}><Label color={k.fg3} size={12} lineHeight={18}>{label as string}</Label></div>{node}</div>)}
        </div>}
        <TaskDock task={task} right={sidePanel} onHeight={setDockHeight} emptyRef={composerEmpty} />
      </div>
    </>
  )
}
