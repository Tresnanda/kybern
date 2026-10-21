import { useGpuixRequired, type PublicInstance } from '@gpuix/react'
import { useEffect, useRef, useState } from 'react'
import { observeElementBounds } from '../native/layout.ts'
import { activeEnvironment } from '../shell/environment.ts'
import { useApp } from '../state.ts'
import { useSpaceProjects } from '../spaces/current.ts'
import { toast } from '../shell/toasts.tsx'
import { ink, Label, useTheme } from '../ui.tsx'
import { Menu, MenuItem } from '../nav/overlay.tsx'
import { ProjectDot, notesTokens } from '../notes/kit.tsx'
import { over } from '../theme.ts'
import { createTask, openTask, setTasks, taskState } from './store.ts'
import { StatusGlyph } from './Glyphs.tsx'

export function QuickAdd({ request, card = false }: { request: NonNullable<ReturnType<typeof taskState>['quick']>; card?: boolean }) {
  const t = useTheme()
  const projects = useSpaceProjects()
  const [title, setTitle] = useState('')
  const [project, setProject] = useState(request.projectId ?? '')
  const [busy, setBusy] = useState(false)
  const renderer = useGpuixRequired()
  const [field, setField] = useState<PublicInstance | null>(null)
  const menuOpen = useRef(false)
  const [owner] = useState(activeEnvironment)
  // Focus only after the native field has painted; no arbitrary delay or early list jump.
  useEffect(() => {
    if (!field) return
    let focused = false
    return observeElementBounds(renderer, field.id, ({ rect }) => {
      if (!focused && rect && rect.width > 0 && rect.height > 0) {
        focused = true
        renderer.focusElement?.(field.id)
      }
    })
  }, [renderer, field])
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
      if (owner !== activeEnvironment()) return
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
      if (value && owner === activeEnvironment())
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
  const name = project ? projects.find((p) => p.id === project)?.name ?? 'Project' : 'Global'
  const cancel = () => { draft.current.title = ''; setTasks({ quick: null }) }
  const keys = (e: { key?: string; modifiers?: { cmd?: boolean; ctrl?: boolean; shift?: boolean }; preventDefault: () => void }) => {
    if (e.key === 'enter' && !e.modifiers?.shift) { e.preventDefault(); void submit(!!(e.modifiers?.cmd || e.modifiers?.ctrl)) }
    else if (e.key === 'escape') { e.preventDefault(); cancel() }
  }
  const onChange = (e: { value?: string }) => { const value = e.value ?? ''; draft.current.title = value; setTitle(value) }
  const settle = () => { if (menuOpen.current || draft.current.busy) return; void submit(); setTasks({ quick: null }) }
  // `.tk-btn`: 28px, 6px padding, 6px gap, the project dot and its name, quiet until hovered.
  const projectButton = (
    <Menu onOpenChange={(open) => { menuOpen.current = open; if (!open && field) queueMicrotask(() => renderer.focusElement?.(field.id)) }} testId="task-quick-project" align="end" sideOffset={6} trigger={() => (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, height: 28, minWidth: 28, paddingLeft: 6, paddingRight: 6, borderRadius: 7, pointerEvents: 'none', hover: { backgroundColor: ink(t, 0.06) } }}>
        <ProjectDot projectId={project || null} />
        <Label color={k.fg2} size={13} lineHeight={19.5} truncate style={{ maxWidth: 128 }}>{name}</Label>
      </div>
    )}>
      {[{ id: '', name: 'Global' }, ...projects].map((p) => <MenuItem testId={`task-quick-project-${p.id || 'global'}`} key={p.id} id={p.id || 'global'} label={p.name} checked={project === p.id} onSelect={() => setProject(p.id)} />)}
    </Menu>
  )
  if (!card) {
    // `.tk-quick`: a 40px row on the row grid (28 priority + 58 key), the status glyph, the title and the project; no buttons, Return adds.
    return (
      <div onMouseDownOutside={settle} style={{ display: 'flex', alignItems: 'center', height: 40, paddingLeft: 20, paddingRight: 12, backgroundColor: ink(t, t.variant === 'dark' ? 0.035 : 0.03) }}>
        <div style={{ width: 86, flexShrink: 0 }} />
        <div style={{ display: 'flex', alignItems: 'center', width: 26, flexShrink: 0 }}><StatusGlyph status={request.status} /></div>
        <input
          ref={setField}
          testId="task-quick-title"
          aria-label="New task title"
          placeholder="Task title"
          value={title}
          readOnly={busy}
          interceptKeys={['enter', 'escape']}
          onChange={onChange}
          onKeyDown={keys}
          theme={{ text: t.text, caret: t.text }}
          style={{ flexGrow: 1, minWidth: 0, height: 28, fontSize: 13, color: t.text, backgroundColor: 'transparent', borderWidth: 0 }}
        />
        {projectButton}
      </div>
    )
  }
  // `.tk-card-quick`: a card (10px 12px, radius 10, the board card's fill and shadow) holding a two-line field and the project button at the foot, right-aligned.
  const dark = t.variant === 'dark'
  return (
    <div style={{ paddingBottom: 8 }}>
      <div onMouseDownOutside={settle} testId="task-quick-card" style={{ display: 'flex', flexDirection: 'column', paddingTop: 10, paddingBottom: 10, paddingLeft: 12, paddingRight: 12, borderRadius: 10, backgroundColor: dark ? over(ink(t, 0.03), t.surface) : t.surface, boxShadow: dark ? { offsetX: 0, offsetY: 1, blurRadius: 2, spreadRadius: 0, color: 'rgba(0, 0, 0, 0.25)' } : { offsetX: 0, offsetY: 1, blurRadius: 2, spreadRadius: 0, color: 'rgba(0, 0, 0, 0.05)' }, borderWidth: dark ? 0 : 0.5, borderColor: 'rgba(0, 0, 0, 0.09)' }}>
        <textarea
          ref={setField}
          testId="task-quick-title"
          aria-label="New task title"
          placeholder="Task title"
          value={title}
          minRows={2}
          maxRows={2}
          readOnly={busy}
          interceptKeys={['enter', 'escape']}
          onChange={onChange}
          onKeyDown={keys}
          theme={{ text: t.text, caret: t.text }}
          style={{ width: '100%', height: 36, minHeight: 36, flexShrink: 0, padding: 0, fontSize: 13, lineHeight: 18, color: t.text, backgroundColor: 'transparent' }}
        />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', marginTop: 4 }}>{projectButton}</div>
      </div>
    </div>
  )
}
