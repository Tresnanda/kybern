import { relativeTime } from '@/lib/format'
import { muted } from '../nav/overlay.tsx'
import { goPage } from '../nav/history.ts'
import { setNotes as setNotesPage } from '../notes/store.ts'
import { onEnvironmentChange } from '../shell/environment.ts'
import { useEffect, useState } from 'react'
import {
  AUTONOMY_OPTIONS, COORDINATOR_ROLES, COORDINATOR_SETTINGS_COPY as COPY,
  effectiveCoordinatorSettings, roleChip, withOverrideField, withRoleOverride, WORKSPACE_OPTIONS,
} from '../../../../packages/kybern-client/src/coordinatorSettings.ts'
import { BRIEF_NOTE_TITLE, PROJECT_SPACE_COPY, projectSpaceNotes } from '../../../../packages/kybern-client/src/projectSpace.ts'
import type { CoordinatorOverrides, Note, NoteSummary, OrchestrationSettings, RoleDefault, Thread } from '../../../../packages/kybern-client/src/types.ts'
import { ModelPicker } from '../composer/ModelPicker.tsx'
import { errorText } from '../nav/actions.ts'
import { N } from '../nav/glyphs.ts'
import { loadProviders } from '../nav/live.ts'
import { Dialog, DialogHeader } from '../nav/overlay.tsx'
import { useNav } from '../nav/store.ts'
import { getClient, getState, set, useApp } from '../state.ts'
import { cachedMarkdownTheme } from '../transcript/kit.tsx'
import { Label, useTheme } from '../ui.tsx'
import { DockFooter, DockSection as Section, ScopeHeader } from './Notes.tsx'
import { Action, ErrorLine, SwitchRow } from './parts.tsx'

export function ProjectPane({ thread }: { thread: Thread }) {
  const t = useTheme()
  const projectId = thread.coordinator_project_id!
  const project = useApp((s) => s.projects.find((p) => p.id === projectId))
  const providers = useNav((s) => s.providers)
  const [notes, setNotes] = useState<NoteSummary[]>([])
  const [global, setGlobal] = useState<OrchestrationSettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [reload, setReload] = useState(0)
  const [selected, setSelected] = useState<NoteSummary | null>(null)
  const [confirm, setConfirm] = useState<'redo' | 'reset' | null>(null)
  useEffect(() => {
    let current = true
    const client = getClient()!
    setError(null)
    void Promise.all([client.call('notes.list', {}), client.call('settings.get', {})]).then(([result, settings]) => {
      if (current) { setNotes(result.notes); setGlobal(settings.orchestration); setLoaded(true) }
    }, (e) => { if (current) setError(errorText(e)) })
    const off = client.onNotification('notes.changed', () => setReload((n) => n + 1))
    return () => { current = false; off() }
  }, [projectId, reload])
  const space = projectSpaceNotes(notes, projectId)
  const effective = effectiveCoordinatorSettings(global, project?.coordinator)
  const current = () => getState().projects.find((p) => p.id === projectId)?.coordinator ?? null
  const write = async (coordinator: CoordinatorOverrides | null) => {
    if (busy) return false
    setBusy(true); setError(null)
    try {
      const result = await getClient()!.call('projects.update', { project_id: projectId, coordinator })
      set({ projects: getState().projects.map((p) => p.id === result.id ? result : p) }); return true
    } catch (e) { setError(errorText(e)); return false } finally { setBusy(false) }
  }
  const switchBrief = async () => {
    if (busy) return
    setBusy(true); setError(null)
    try {
      const result = await getClient()!.call('projects.update', { project_id: projectId, brief_in_all_threads: !project?.brief_in_all_threads })
      set({ projects: getState().projects.map((p) => p.id === result.id ? result : p) })
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  return <>
    <ScopeHeader thread={thread} action={null} />
    <ErrorLine error={error} retry={() => setReload((n) => n + 1)} />
    <virtual-list testId="dock-project-list" style={{ flexGrow: 1, minHeight: 0, width: '100%' }}>
      <div key="brief">{loaded && <Brief projectId={projectId} summary={space.brief} onSave={() => setReload((n) => n + 1)} />}</div>
      <div key="setup-heading" style={{ paddingTop: 8 }}><Section label="Setup" /></div>
      <div key="setup">{space.setup ? <NoteRow note={space.setup} onClick={() => setSelected(space.setup)} /> : <Hint>{PROJECT_SPACE_COPY.setupEmpty}</Hint>}</div>
      <div key="memory-heading" style={{ paddingTop: 8 }}><Section label="Memory" count={space.memory.length || undefined} /></div>
      {space.memory.length ? space.memory.map((note) => <NoteRow key={note.id} note={note} onClick={() => setSelected(note)} />) : <Hint key="memory-empty">{PROJECT_SPACE_COPY.memoryEmpty}</Hint>}
      <div key="coordinator-heading" style={{ paddingTop: 8 }}><Section label={COPY.section}><Action textSize={13} onClick={() => setConfirm('redo')}>{COPY.redo}</Action></Section></div>
      <div key="coordinator" style={{ display: 'flex', flexDirection: 'column', gap: 14, marginLeft: 6, marginRight: 6, padding: 10, paddingBottom: 6, borderRadius: 8, borderWidth: 1, borderColor: t.borderLight }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><Choice label={COPY.autonomy} value={effective.lead_autonomy} options={AUTONOMY_OPTIONS} disabled={busy} onChange={value => void write(withOverrideField(current(), 'lead_autonomy', value as typeof effective.lead_autonomy))} />
        <Label color={t.textTertiary} size={13} lineHeight={18.2}>{AUTONOMY_OPTIONS.find(o => o.value === effective.lead_autonomy)!.hint}</Label></div>
        <Choice label={COPY.workspace} value={effective.lead_workspace} options={WORKSPACE_OPTIONS} disabled={busy} onChange={value => void write(withOverrideField(current(), 'lead_workspace', value as typeof effective.lead_workspace))} />
        <SwitchRow title={COPY.push} detail={COPY.pushDetail} checked={effective.lead_push_without_asking} disabled={busy} onChange={() => void write(withOverrideField(current(), 'lead_push_without_asking', !effective.lead_push_without_asking))} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><Label color={t.textSecondary} size={13} lineHeight={16}>{COPY.models}</Label><div style={{ display: 'flex', flexDirection: 'column', borderRadius: 8, borderWidth: 1, borderColor: t.borderLight, backgroundColor: t.v('--color-background-elevated-primary-opaque'), overflow: 'hidden' }}>
        {COORDINATOR_ROLES.map(({ role, label }) => {
          const value = project?.coordinator?.role_defaults?.[role]
          const chosen = effective.role_defaults[role]
          const chip = roleChip(role, global, project?.coordinator, providers, 'project')
          const change = (next: RoleDefault | null) => write(withRoleOverride(current(), role, next))
          return <div key={role} style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, minHeight: 36, paddingLeft: 10, paddingRight: 8, borderBottomWidth: role === 'test' ? 0 : 1, borderColor: t.borderLight }}>
            <Label color={t.text} size={14} style={{ flexGrow: 1 }}>{label}</Label>
            <ModelPicker provider={chosen?.provider ?? thread.provider} providers={providers} model={chosen?.model} effort={chosen?.effort} accounts={[]} canPickModel canPickProvider canReload loading={false} busy={busy}
              onModelChange={(model, effort) => change({ ...value, model, effort })}
              onEffortChange={(effort) => change({ ...value, effort })}
              onProviderChange={(provider, choice) => change({ provider, model: choice?.model, effort: choice?.effort })}
              onReload={() => void loadProviders(true)} label={(color) => <Label color={color} size={12} truncate>{chip.label}</Label>} />
            {value && <Action disabled={busy} onClick={() => void change(null)}>Reset</Action>}
          </div>
        })}</div></div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
          <Label color={t.textTertiary} size={10}>{COPY.defaultsFrom}</Label>
          <Action disabled={busy || !project?.coordinator} onClick={() => setConfirm('reset')}>{COPY.reset}</Action>
        </div>
      </div>
      <div key="brief-switch" style={{ margin: 6, padding: 10, borderRadius: 8, borderWidth: 0.6, borderColor: t.borderLight }}>
        <SwitchRow title={PROJECT_SPACE_COPY.switchTitle} detail={PROJECT_SPACE_COPY.switchDetail} checked={!!project?.brief_in_all_threads} disabled={busy} testId="dock-project-brief-switch" onChange={() => void switchBrief()} />
      </div>
      <DockFooter key="all-notes" testId="dock-project-all-notes" onClick={() => { setNotesPage({ selected: null, filter: { kind: 'project', projectId } }); goPage('notes') }}>Show all in Notes</DockFooter>
    </virtual-list>
    {selected && <NoteDialog summary={selected} onClose={() => setSelected(null)} />}
    {confirm && <Dialog onClose={() => { if (!busy) setConfirm(null) }} width={430}>
      <DialogHeader title={confirm === 'redo' ? COPY.redoTitle : COPY.resetTitle} description={confirm === 'redo' ? COPY.redoDetail : COPY.resetDetail} onClose={() => { if (!busy) setConfirm(null) }} />
      <div style={{ display: 'flex', justifyContent: 'flex-end', padding: 12, gap: 8 }}>
        <Action press={false} disabled={busy} onClick={() => setConfirm(null)}>Cancel</Action>
        <Action disabled={busy} onClick={() => { void (async () => {
          if (confirm === 'reset') { if (await write(null)) setConfirm(null) }
          else { setBusy(true); try { await getClient()!.call('coordinator.setup', { project_id: projectId }); setConfirm(null) } catch (e) { setError(errorText(e)) } finally { setBusy(false) } }
        })() }}>{confirm === 'redo' ? COPY.redo : COPY.reset}</Action>
      </div>
    </Dialog>}
  </>
}

function Hint({ children }: { children: string }) {
  const t = useTheme()
  return <div style={{ display: 'flex', width: '100%', paddingLeft: 14, paddingRight: 14, paddingTop: 2, paddingBottom: 8 }}><Label color={t.textTertiary} size={13} lineHeight={16} style={{ flexGrow: 1, minWidth: 0, whiteSpace: 'normal' }}>{children}</Label></div>
}

function Choice({ label, value, options, disabled, onChange }: { label: string; value: string; options: readonly { value: string; label: string }[]; disabled: boolean; onChange: (value: string) => void }) {
  const t = useTheme()
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
    <Label color={t.textSecondary} size={13} lineHeight={16}>{label}</Label>
    <div role="radiogroup" aria-label={label} onKeyDown={e => { const step = e.key === 'right' || e.key === 'down' ? 1 : e.key === 'left' || e.key === 'up' ? -1 : 0; if (step && !disabled) onChange(options[(options.findIndex(o => o.value === value) + step + options.length) % options.length]!.value) }} style={{ display: 'flex', height: 30, padding: 2, backgroundColor: t.variant === 'dark' ? t.v('--background') : t.v('--color-background-elevated-secondary'), borderRadius: 8, borderWidth: 1, borderColor: t.borderLight }}>{options.map(option => <div key={option.value} role="radio" aria-checked={option.value === value} aria-label={option.label} tabIndex={disabled || option.value !== value ? -1 : 0} aria-disabled={disabled} onClick={() => { if (!disabled) onChange(option.value) }} onKeyDown={e => { if (!disabled && (e.key === 'enter' || e.key === 'space')) onChange(option.value) }} style={{ flexGrow: 1, flexBasis: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, borderWidth: option.value === value ? 1 : 0, borderColor: t.borderLight, backgroundColor: option.value === value ? t.composer : 'transparent', cursor: disabled ? 'default' : 'pointer' }}><Label size={14} color={option.value === value ? t.text : t.textSecondary}>{option.label}</Label></div>)}</div>
  </div>
}

function NoteRow({ note, onClick }: { note: NoteSummary; onClick: () => void }) {
  const t = useTheme()
  return <div style={{ paddingLeft: 6, paddingRight: 6 }}><div role="button" onClick={onClick} style={{ display: 'flex', flexDirection: 'column', gap: 3, paddingLeft: 8, paddingRight: 8, paddingTop: 6, paddingBottom: 6, borderRadius: 8, cursor: 'pointer', hover: { backgroundColor: t.buttonSecondaryHover } }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Label color={t.text} size={14} lineHeight={21} truncate style={{ flexGrow: 1 }}>{note.title}</Label><Label color={muted(t, 0.65)} size={13}>{relativeTime(note.updated_at)}</Label></div><Label color={muted(t, 0.7)} size={13} lineHeight={19.5} truncate>{note.preview}</Label>
  </div></div>
}

// Unmount hidden panes without dropping an unsaved brief or advancing the
// revision it was based on when another client edits the note.
const briefDrafts = new Map<string, { body: string; base: Note | null }>()
function Brief({ projectId, summary, onSave }: { projectId: string; summary: NoteSummary | null; onSave: () => void }) {
  const t = useTheme()
  const [note, setNote] = useState<Note | null>(null)
  const [body, setBody] = useState(() => briefDrafts.get(projectId)?.body ?? '')
  const [base, setBase] = useState<Note | null>(() => briefDrafts.get(projectId)?.base ?? null)
  const [editing, setEditing] = useState(() => briefDrafts.has(projectId))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!summary) return
    let current = true
    void getClient()!.call('notes.get', { id: summary.id }).then((result) => { if (current) setNote(result.note ?? null) }, (e) => { if (current) setError(errorText(e)) })
    return () => { current = false }
  }, [summary?.id, summary?.revision])
  const save = async () => {
    if (busy) return
    setBusy(true); setError(null)
    try {
      const result = base ? await getClient()!.call('notes.update', { id: base.id, expected_revision: base.revision, body }) : await getClient()!.call('notes.create', { scope: 'project', project_id: projectId, project_role: 'brief', title: BRIEF_NOTE_TITLE, body })
      briefDrafts.delete(projectId); setNote(result); setEditing(false); onSave()
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  return <>
    <Section label="Brief"><Action testId={busy || (!editing && !!summary && !note) ? 'dock-brief-loading' : 'dock-brief-edit'} disabled={busy || (!editing && !!summary && !note)} onClick={() => {
      if (editing) { briefDrafts.delete(projectId); setEditing(false) }
      else {
        if (briefDrafts.size >= 40) briefDrafts.delete(briefDrafts.keys().next().value!)
        briefDrafts.set(projectId, { body: note?.body ?? '', base: note })
        setBase(note); setBody(note?.body ?? ''); setEditing(true)
      }
    }}>{editing ? 'Cancel' : summary ? 'Edit' : 'Write'}</Action></Section>
    <ErrorLine error={error} />
    <div style={{ marginLeft: 6, marginRight: 6, paddingTop: editing ? 0 : 8, borderRadius: 8, backgroundColor: editing ? 'transparent' : t.buttonSecondary }}>
    {editing ? <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 8, paddingRight: 8 }}>
      <textarea testId="dock-brief-editor" value={body} onChange={(e) => { const text = e.value ?? ''; setBody(text); briefDrafts.set(projectId, { body: text, base }) }} placeholder={PROJECT_SPACE_COPY.briefPlaceholder} style={{ height: 160, width: '100%', fontSize: 12, color: t.text, backgroundColor: t.buttonSecondary, borderRadius: 8, padding: 8 }} />
      <Action disabled={busy} testId="dock-brief-save" onClick={() => void save()}>{busy ? 'Saving…' : 'Save brief'}</Action>
    </div> : note?.body ? <div style={{ paddingLeft: 8, paddingRight: 8, maxHeight: 180, overflow: 'hidden' }}><markdown source={note.body} theme={cachedMarkdownTheme(t)} /></div> : <Hint>{summary?.preview || PROJECT_SPACE_COPY.briefEmpty}</Hint>}
    <div style={{ paddingTop: 6, paddingBottom: 6, paddingLeft: 8, paddingRight: 8 }}><Label color={t.textTertiary} size={13} lineHeight={16}>{PROJECT_SPACE_COPY.briefOwner}</Label></div>
    </div>
    <div style={{ height: 8 }} />
  </>
}

function NoteDialog({ summary, onClose }: { summary: NoteSummary; onClose: () => void }) {
  const t = useTheme()
  const [body, setBody] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let current = true
    void getClient()!.call('notes.get', { id: summary.id }).then((result) => { if (current) setBody(result.note?.body ?? '') }, (e) => { if (current) setError(errorText(e)) })
    return () => { current = false }
  }, [summary.id])
  return <Dialog onClose={onClose} width={600} testId="dock-project-note">
    <DialogHeader title={summary.title} onClose={onClose} />
    <ErrorLine error={error} />
    <div style={{ height: 420, overflow: 'scroll', padding: 16 }}>
      {body !== null ? <markdown source={body} theme={cachedMarkdownTheme(t)} /> : !error && <Label color={t.textSecondary} size={12}>Loading note…</Label>}
    </div>
  </Dialog>
}

onEnvironmentChange(() => { briefDrafts.clear() })
