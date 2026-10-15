import { useEffect, useRef, useState } from 'react'
import { Button, Select, TextField } from '../settings/controls.tsx'
import { useApp } from '../state.ts'
import { toast } from '../shell/toasts.tsx'
import { ink, useTheme } from '../ui.tsx'
import { createTask, openTask, setTasks, taskState } from './store.ts'
import { StatusGlyph } from './Glyphs.tsx'

export function QuickAdd({ request, card = false }: { request: NonNullable<ReturnType<typeof taskState>['quick']>; card?: boolean }) {
  const t = useTheme()
  const projects = useApp((s) => s.projects)
  const [title, setTitle] = useState('')
  const [project, setProject] = useState(request.projectId ?? '')
  const [busy, setBusy] = useState(false)
  const draft = useRef({ title: '', project, busy: false })
  draft.current.project = project
  const submit = async (open = false) => {
    const value = draft.current.title.trim()
    if (!value || draft.current.busy) return
    draft.current.title = ''
    draft.current.busy = true
    setBusy(true)
    try {
      const task = await createTask({
        scope: draft.current.project ? 'project' : 'global',
        project_id: draft.current.project || null,
        title: value,
        status: request.status,
        priority: request.priority,
      })
      setTitle('')
      if (open) openTask(task.id)
    } catch (error) {
      draft.current.title = value
      setTitle(value)
      toast.error(`Unable to add “${value}”`, { description: String(error) })
    } finally {
      draft.current.busy = false
      setBusy(false)
    }
  }
  useEffect(
    () => () => {
      const value = draft.current.title.trim()
      draft.current.title = ''
      if (value)
        void createTask({
          scope: draft.current.project ? 'project' : 'global',
          project_id: draft.current.project || null,
          title: value,
          status: request.status,
          priority: request.priority,
        }).catch((error) => toast.error(`Unable to add “${value}”`, { description: String(error) }))
    },
    [request],
  )
  return (
    <div
      style={{
        display: 'flex',
        alignItems: card ? 'stretch' : 'center',
        flexDirection: card ? 'column' : 'row',
        gap: 8,
        paddingLeft: card ? 10 : 20,
        paddingRight: card ? 10 : 20,
        paddingTop: 6,
        paddingBottom: 6,
        backgroundColor: ink(t, 0.03),
      }}
    >
      <StatusGlyph status={request.status} />
      <TextField
        autoFocus
        testId="task-quick-title"
        label="Task title"
        placeholder="Task title"
        value={title}
        onChange={(value) => {
          draft.current.title = value
          setTitle(value)
        }}
        width="100%"
        style={{ flexGrow: 1 }}
        onKeyDown={(e) => {
          if (e.key === 'enter') void submit(!!e.modifiers?.cmd)
          if (e.key === 'escape') {
            draft.current.title = ''
            setTasks({ quick: null })
          }
        }}
      />
      <Select
        testId="task-quick-project"
        label="Project"
        value={project}
        onChange={setProject}
        options={[{ value: '', label: 'Global' }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
      />
      <Button
        testId="task-quick-add"
        disabled={busy || !title.trim()}
        onClick={() => {
          void submit()
        }}
      >
        Add task
      </Button>
      <Button
        onClick={() => {
          draft.current.title = ''
          setTasks({ quick: null })
        }}
      >
        Cancel
      </Button>
    </div>
  )
}
