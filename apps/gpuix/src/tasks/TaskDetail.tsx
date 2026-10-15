import { DecoratedTextarea } from '../native/decorated-input.tsx'
import { markdownInputDecorations, noteInputMarkColors } from '../native/input-marks.ts'
import { useEffect, useMemo, useState } from 'react'
import { useWindowSize } from '@gpuix/react'
import { relativeTime } from '@/lib/format'
import { Icon } from '../icons.tsx'
import { N } from '../nav/glyphs.ts'
import { useSidebarWidth } from '../shell/layout.ts'
import { notesTokens } from '../notes/kit.tsx'
import { setDetailSequence } from './Header.tsx'
import { composeTaskBody, latestRun, runOutcome, splitTaskBody, STATUS_LABEL, taskActivity } from '@/state/tasksModel'
import type { Note, TaskItem } from '../../../../packages/kybern-client/src/types.ts'
import { getClient } from '../state.ts'
import { openThread } from '../nav/history.ts'
import { Menu, MenuItem } from '../nav/overlay.tsx'
import { useNotes, rpc as noteRpc } from '../notes/store.ts'
import { Toolbar } from '../notes/Toolbar.tsx'
import { formatBlock } from '../notes/blocks.ts'
import { openLink } from '../notes/NoteEditor.tsx'
import { Button, TextField } from '../settings/controls.tsx'
import { FONT_UI } from '../theme.ts'
import { ink, Label, ProviderMark, useTheme } from '../ui.tsx'
import { cachedMarkdownTheme } from '../transcript/kit.tsx'
import { Check } from './Glyphs.tsx'
import { MoreMenu, ProjectMenu, TaskMenus } from './TaskMenus.tsx'
import { useTaskAutosave } from './autosave.ts'
import { openTask, taskTyping, setTasks, updateTask } from './store.ts'

const TICK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M2.2 5.2 4.1 7.1 7.9 3" fill="none" stroke="#000" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'

export function TaskDetail({ task, sequence }: { task: TaskItem; sequence: string[] }) {
  const t = useTheme()
  // `.tk-desc .note-prose`: 15/24 prose at 86% ink, inline code at 0.833em.
  const descTheme = useMemo(() => { const base = cachedMarkdownTheme(t); return { ...base, text: t.variant === 'dark' ? 'rgba(252, 252, 252, 0.86)' : 'rgba(13, 13, 13, 0.86)', metrics: { ...base.metrics, mdTextSize: 15, mdLineHeight: 24, codeTextSize: 12.5 } } }, [t])
  const availableNotes = useNotes((s) => s.notes)
  const describe = (description: string) => edit.editBody(composeTaskBody(description, parts.criteria))
  const [editing, setEditing] = useState(false)
  const edit = useTaskAutosave(task)
  const [notes, setNotes] = useState<(Note | { id: string; title: string; body: string })[]>([])
  const [expandedNote, setExpandedNote] = useState<string | null>(null)
  const parts = splitTaskBody(edit.body)
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
            {editing ? (
              <>
                <TextField
                  testId="task-edit-title"
                  onFocus={() => taskTyping(true)}
                  onBlur={() => {
                    taskTyping(false)
                    void edit.flush()
                  }}
                  label="Task title"
                  value={edit.title}
                  onChange={edit.editTitle}
                  width="100%"
                />
                <Toolbar disabled={false} active format={(kind) => describe(formatBlock(parts.description, kind))} mark={(marker) => describe(`${marker}${parts.description.trimEnd()}${marker}`)} link={(label, href) => describe(`${parts.description} [${label.replace(/[\\[\]]/g, '\\$&')}](${encodeURI(href).replaceAll('(', '%28').replaceAll(')', '%29')})`)} finish={() => { void edit.flush(); setEditing(false); taskTyping(false) }} />
                <DecoratedTextarea
                  decorations={markdownInputDecorations(parts.description, noteInputMarkColors(t))}
                  testId="task-edit-body"
                  onFocus={() => taskTyping(true)}
                  onBlur={() => {
                    taskTyping(false)
                    void edit.flush()
                  }}
                  value={parts.description}
                  onChange={(e) => edit.editBody(composeTaskBody(e.value ?? '', parts.criteria))}
                  placeholder="Add a description…"
                  style={{
                    height: 220,
                    width: '100%',
                    color: t.text,
                    fontFamily: FONT_UI,
                    fontSize: 15,
                    backgroundColor: t.surface,
                    padding: 12,
                    borderWidth: 1,
                    borderColor: t.border,
                    borderRadius: 8,
                  }}
                />
                {edit.conflict && <div style={{ display: 'flex', gap: 8 }}><Button testId="task-use-theirs" onClick={edit.useTheirs}>Use theirs</Button><Button testId="task-keep-mine" onClick={edit.keepMine}>Keep mine</Button></div>}
                {edit.error && (
                  <Label color={t.red} size={12}>
                    {edit.error}
                  </Label>
                )}
                <div style={{ display: 'flex', gap: 8 }}>
                  <Label color={t.textTertiary} size={12}>
                    {edit.saving ? 'Saving…' : 'Changes save automatically'}
                  </Label>
                  {edit.error && (
                    <Button
                      onClick={() => {
                        void edit.flush()
                      }}
                    >
                      Retry saving
                    </Button>
                  )}
                  <Button
                    testId="task-edit-done"
                    onClick={() => {
                      void edit.flush()
                      taskTyping(false)
                      setEditing(false)
                    }}
                  >
                    Done
                  </Button>
                </div>
              </>
            ) : (
              <div testId="task-edit" onClick={beginEdit} style={{ display: 'flex', flexDirection: 'column', gap: 14, cursor: 'text' }}>
                <Label color={t.text} size={28} lineHeight={34} weight={650}>
                  {task.title || 'Untitled'}
                </Label>
                {parts.description ? (
                  <markdown
                    theme={descTheme}
                    source={parts.description}
                    onLinkClick={(e) => { if (e.value) openLink(e.value) }}
                    style={{ color: ink(t, 0.86), fontSize: 15, userSelect: 'text' }}
                  />
                ) : (
                  <Label color={t.textTertiary} size={15} lineHeight={24}>
                    Add a description…
                  </Label>
                )}
              </div>
            )}
          </div>
          {(parts.criteria.length > 0 || !editing) && (
            <div key="criteria-title" style={{ ...padding, paddingTop: 36, paddingBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Label color={t.text} size={13} lineHeight={19.5} weight={600}>Acceptance criteria</Label>
              {parts.criteria.length > 0 && <Label color={k.fg3} size={13} lineHeight={19.5}>{`${parts.criteria.filter((c) => c.checked).length} of ${parts.criteria.length}`}</Label>}
            </div>
          )}
          {parts.criteria.map((criterion, index) => (
            <div key={`criterion-${index}`} style={{ ...padding, display: 'flex', alignItems: 'flex-start', gap: 12, minHeight: 32, paddingTop: 4, paddingBottom: 4 }}>
              <div testId={`task-criterion-${index}`} role="checkbox" aria-checked={criterion.checked} aria-label="Select task" tabIndex={0} onClick={() => {
                const next = parts.criteria.map((c, i) => (i === index ? { ...c, checked: !c.checked } : c))
                edit.editBody(composeTaskBody(parts.description, next))
                void edit.flush()
              }} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 16, height: 16, marginTop: 4, borderRadius: 4.5, flexShrink: 0, cursor: 'pointer', ...(criterion.checked ? { backgroundColor: k.checkOn } : { borderWidth: 1.5, borderColor: k.fg4, hover: { borderColor: k.fg3 } }) }}>
                {criterion.checked && <svg source={TICK} style={{ width: 10.5, height: 10.5, color: t.surface }} />}
              </div>
              {editing ? (
                <>
                  <TextField
                    testId={`task-criterion-text-${index}`}
                    label="Acceptance criterion"
                    value={criterion.text}
                    onFocus={() => taskTyping(true)}
                    onBlur={() => {
                      taskTyping(false)
                      void edit.flush()
                    }}
                    onChange={(text) =>
                      edit.editBody(
                        composeTaskBody(
                          parts.description,
                          parts.criteria.map((c, i) => (i === index ? { ...c, text } : c)),
                        ),
                      )
                    }
                    width="100%"
                    style={{ flexGrow: 1 }}
                  />
                  <Button
                    onClick={() => {
                      edit.editBody(
                        composeTaskBody(
                          parts.description,
                          parts.criteria.filter((_, i) => i !== index),
                        ),
                      )
                      void edit.flush()
                    }}
                  >
                    Remove
                  </Button>
                </>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 }}>
                  <Label color={criterion.checked ? k.fg3 : k.fg1} size={15} lineHeight={24} style={{ width: '100%' }}>{[criterion.text, ...(criterion.extra ?? [])].join(' ')}</Label>
                </div>
              )}
            </div>
          ))}
          {editing ? (
            <div key="add-criterion" style={padding}>
              <Button
                testId="task-add-criterion"
                onClick={() =>
                  edit.editBody(composeTaskBody(parts.description, [...parts.criteria, { text: 'New criterion', checked: false }]))
                }
              >
                Add criterion
              </Button>
            </div>
          ) : (
            <div key="add-criterion-ghost" style={padding}>
              <div testId="task-add-criterion-ghost" onClick={() => { beginEdit(); edit.editBody(composeTaskBody(parts.description, [...parts.criteria, { text: 'New criterion', checked: false }])) }} style={{ display: 'flex', alignItems: 'center', gap: 8, height: 32, marginLeft: -8, marginRight: -8, paddingLeft: 8, paddingRight: 8, borderRadius: 7, cursor: 'pointer', hover: { backgroundColor: ink(t, 0.05) } }}>
                <Icon source={N.plus} size={14} color={k.fg3} /><Label color={k.fg3} size={13} lineHeight={19.5}>Add a criterion</Label>
              </div>
            </div>
          )}
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
