import { useEffect, useState } from 'react'
import { composeTaskBody, latestRun, runOutcome, splitTaskBody, STATUS_LABEL, taskActivity } from '@/state/tasksModel'
import type { Note, TaskItem } from '../../../../packages/kybern-client/src/types.ts'
import { getClient } from '../state.ts'
import { openThread } from '../nav/history.ts'
import { Button, TextField } from '../settings/controls.tsx'
import { FONT_UI } from '../theme.ts'
import { Label, useTheme } from '../ui.tsx'
import { cachedMarkdownTheme } from '../transcript/kit.tsx'
import { Check } from './Glyphs.tsx'
import { MoreMenu, ProjectMenu, TaskMenus } from './TaskMenus.tsx'
import { useTaskAutosave } from './autosave.ts'
import { openTask, taskTyping, setTasks } from './store.ts'

export function TaskDetail({ task, sequence }: { task: TaskItem; sequence: string[] }) {
  const t = useTheme()
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
  const padding = { paddingLeft: 36, paddingRight: 36, paddingBottom: 24 }
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, height: 48, paddingLeft: 20, paddingRight: 20 }}>
        <Button testId="task-back" onClick={() => openTask(null)}>
          Tasks
        </Button>
        <Label color={t.textTertiary} size={13}>
          /
        </Label>
        <Label color={t.text} size={13} style={{ flexGrow: 1 }}>
          {task.key}
        </Label>
        {run && <Button onClick={() => openThread(run.thread_id)}>Open run</Button>}
        <Button disabled={at <= 0} onClick={() => openTask(sequence[at - 1]!)}>
          ↑
        </Button>
        <Button disabled={at < 0 || at === sequence.length - 1} onClick={() => openTask(sequence[at + 1]!)}>
          ↓
        </Button>
        <MoreMenu task={task} sequence={sequence} />
      </div>
      <div style={{ display: 'flex', flexGrow: 1, minHeight: 0 }}>
        <virtual-list testId="task-detail" style={{ flexGrow: 1, minWidth: 0, minHeight: 0 }}>
          <div key="content" style={{ ...padding, paddingTop: 30, display: 'flex', flexDirection: 'column', gap: 18 }}>
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
                <textarea
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
              <>
                <Label color={t.text} size={28} weight={600}>
                  {task.title || 'Untitled'}
                </Label>
                {parts.description ? (
                  <markdown
                    theme={cachedMarkdownTheme(t)}
                    source={parts.description}
                    style={{ color: t.text, fontSize: 15, userSelect: 'text' }}
                  />
                ) : (
                  <Label color={t.textTertiary} size={15}>
                    Add a description…
                  </Label>
                )}
                <div style={{ display: 'flex' }}>
                  <Button testId="task-edit" onClick={beginEdit}>
                    Edit task
                  </Button>
                </div>
              </>
            )}
          </div>
          {parts.criteria.length > 0 && (
            <div key="criteria-title" style={padding}>
              <Label
                color={t.text}
                size={17}
                weight={500}
              >{`Acceptance criteria · ${parts.criteria.filter((c) => c.checked).length}/${parts.criteria.length}`}</Label>
            </div>
          )}
          {parts.criteria.map((criterion, index) => (
            <div key={`criterion-${index}`} style={{ ...padding, paddingBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Check
                testId={`task-criterion-${index}`}
                checked={criterion.checked}
                onClick={() => {
                  const next = parts.criteria.map((c, i) => (i === index ? { ...c, checked: !c.checked } : c))
                  edit.editBody(composeTaskBody(parts.description, next))
                  void edit.flush()
                }}
              />
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
                <markdown
                  theme={cachedMarkdownTheme(t)}
                  source={[criterion.text, ...(criterion.extra ?? [])].join('\n')}
                  style={{ color: t.textSecondary, flexGrow: 1, fontSize: 15 }}
                />
              )}
            </div>
          ))}
          {editing && (
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
          )}
          <div key="notes-title" style={{ ...padding, paddingTop: 20 }}>
            <Label color={t.text} size={17} weight={500}>
              Linked notes
            </Label>
          </div>
          {!notes.length && (
            <div key="no-notes" style={padding}>
              <Label color={t.textTertiary} size={13}>
                No linked notes
              </Label>
            </div>
          )}
          {notes.map((note) => (
            <div key={note.id} style={{ ...padding, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <Button onClick={() => setExpandedNote(expandedNote === note.id ? null : note.id)}>{note.title || 'Untitled note'}</Button>
              {expandedNote === note.id && (
                <markdown theme={cachedMarkdownTheme(t)} source={note.body} style={{ color: t.text, userSelect: 'text' }} />
              )}
            </div>
          ))}
          <div key="activity-title" style={{ ...padding, paddingTop: 12 }}>
            <Label color={t.text} size={17} weight={500}>
              Activity
            </Label>
          </div>
          {taskActivity(task).map((event, index) => (
            <div key={`activity-${index}`} style={{ ...padding, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Label color={t.textTertiary} size={12}>
                {new Date(event.at).toLocaleString()}
              </Label>
              <Label color={t.textSecondary} size={13}>
                {event.kind === 'created'
                  ? 'Created task'
                  : event.kind === 'status'
                    ? `Changed status to ${STATUS_LABEL[event.status]}`
                    : `Run ${event.run.number} · ${runOutcome(event.run, Date.now())}`}
              </Label>
              {event.kind === 'run' && (
                <div style={{ display: 'flex' }}>
                  <Button onClick={() => openThread(event.run.thread_id)}>Open run</Button>
                </div>
              )}
            </div>
          ))}
        </virtual-list>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
            width: 200,
            flexShrink: 0,
            padding: 18,
            borderLeftWidth: 1,
            borderColor: t.borderLight,
          }}
        >
          <Label color={t.text} size={13} weight={500}>
            Properties
          </Label>
          <Label color={t.textTertiary} size={12}>
            Status
          </Label>
          <TaskMenus ids={[task.id]} property="status" />
          <Label color={t.textTertiary} size={12}>
            Priority
          </Label>
          <TaskMenus ids={[task.id]} property="priority" />
          <Label color={t.textTertiary} size={12}>
            Project
          </Label>
          <ProjectMenu task={task} />
          <Label color={t.textTertiary} size={12}>
            Created
          </Label>
          <Label color={t.textSecondary} size={12}>
            {new Date(task.created_at).toLocaleDateString()}
          </Label>
          <Button testId="task-send-open" onClick={() => setTasks({ composer: [task.id] })}>
            Send to agent
          </Button>
        </div>
      </div>
    </>
  )
}
