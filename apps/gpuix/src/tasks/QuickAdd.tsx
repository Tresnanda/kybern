import { useEffect, useRef, useState } from 'react'
import { Button, Select, TextField } from '../settings/controls.tsx'
import { useApp } from '../state.ts'
import { toast } from '../shell/toasts.tsx'
import { ink, Label, useTheme } from '../ui.tsx'
import { Menu, MenuItem } from '../nav/overlay.tsx'
import { ProjectDot, notesTokens } from '../notes/kit.tsx'
import { createTask, openTask, setTasks, taskState } from './store.ts'
import { StatusGlyph } from './Glyphs.tsx'

export function QuickAdd({ request, card = false }: { request: NonNullable<ReturnType<typeof taskState>['quick']>; card?: boolean }) {
  const t = useTheme()
  const projects = useApp((s) => s.projects)
  const [title, setTitle] = useState('')
  const [project, setProject] = useState(request.projectId ?? '')
  const [busy, setBusy] = useState(false)
  // Focusing on mount scrolls the virtual list to its end before layout settles; focus a frame later.
  const [ready, setReady] = useState(false)
  useEffect(() => { const id = setTimeout(() => setReady(true), 120); return () => clearTimeout(id) }, [])
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
  const k = notesTokens(t)
  const input = (
    <input
      autoFocus={ready}
      testId="task-quick-title"
      aria-label="Task title"
      placeholder="Task title"
      value={title}
      onChange={(e) => {
        const value = e.value ?? ''
        draft.current.title = value
        setTitle(value)
      }}
      onKeyDown={(e) => {
        if (e.key === 'enter') void submit(!!e.modifiers?.cmd)
        if (e.key === 'escape') {
          draft.current.title = ''
          setTasks({ quick: null })
        }
      }}
      style={{ flexGrow: 1, minWidth: 0, height: 28, fontSize: 13, color: t.text, backgroundColor: 'transparent', borderWidth: 0 }}
    />
  )
  if (!card) {
    // `.tk-quick`: a 40px row on the row grid (28 priority + 58 key + 26 status), then the title and the project.
    const name = projects.find((p) => p.id === project)?.name ?? 'Global'
    return (
      <div style={{ display: 'flex', alignItems: 'center', height: 40, paddingLeft: 20, paddingRight: 20, backgroundColor: ink(t, t.variant === 'dark' ? 0.035 : 0.03) }}>
        <div style={{ width: 86, flexShrink: 0 }} />
        <div style={{ display: 'flex', alignItems: 'center', width: 26, flexShrink: 0 }}><StatusGlyph status={request.status} /></div>
        {input}
        {!!title.trim() && <div testId="task-quick-add" onClick={() => { void submit() }} style={{ display: 'flex', alignItems: 'center', height: 24, paddingLeft: 8, paddingRight: 8, borderRadius: 6, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.5 : 1, hover: { backgroundColor: ink(t, 0.06) } }}><Label color={k.fg2} size={12}>Add</Label></div>}
        <Menu testId="task-quick-project" align="end" sideOffset={6} trigger={() => <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: 132, paddingLeft: 12, pointerEvents: 'none' }}><ProjectDot projectId={project || null} /><Label color={ink(t, 0.6)} size={12} lineHeight={18} truncate>{name}</Label></div>}>
          {[{ id: '', name: 'Global' }, ...projects].map((p) => <MenuItem key={p.id} id={p.id || 'global'} label={p.name} checked={project === p.id} onSelect={() => setProject(p.id)} />)}
        </Menu>
        <div style={{ width: 34, flexShrink: 0 }} />
      </div>
    )
  }
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
