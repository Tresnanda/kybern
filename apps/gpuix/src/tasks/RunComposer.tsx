import { useEffect, useMemo, useRef, useState } from 'react'
import { isLiveRun, latestRun } from '@/state/tasksModel'
import type {
  GitBranchesResult,
  PermissionMode,
  ProviderInstance,
  TaskBatchMode,
  UserMessage,
} from '../../../../packages/kybern-client/src/types.ts'
import { ComposerView } from '../Composer.tsx'
import { ensureLoaded, loadProviders, useComposer } from '../composer/store.ts'
import { openThread } from '../nav/history.ts'
import { Button, Segmented, Select } from '../settings/controls.tsx'
import { getClient, useApp } from '../state.ts'
import { load, save } from '../shell/persist.ts'
import { toast } from '../shell/toasts.tsx'
import { Label, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { SwapOnChange } from '../motion/kit.tsx'
import { Presence } from '../motion/Presence.tsx'
import { DURATION, EASE } from '../motion/tokens.ts'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { setTasks, taskState, upsert, useTasks, updateTask, openTask } from './store.ts'

interface SendPrefs {
  provider?: ProviderInstance
  model?: string | null
  effort?: string | null
  permissionMode?: PermissionMode
  useWorktree?: boolean
  baseBranch?: string | null
}
const SEND_KEY = 'kybern.tasks.send:local'

/** Uses the shared composer, so attachments, completions, model/account and permission pickers stay identical. */
export function RunComposer({ ids }: { ids: string[] }) {
  const t = useTheme()
  const tasks = useTasks((s) => s.tasks)
  const picked = ids.flatMap((id) => (tasks[id] ? [tasks[id]!] : []))
  const single = picked.length === 1 ? picked[0] : undefined
  const run = single ? latestRun(single) : null
  const live = isLiveRun(run)
  const [kind, setKind] = useState<'run' | 'followup'>(() => (run && (live || single?.status === 'needs_review') ? 'followup' : 'run'))
  const followup = !!single && !!run && (kind === 'followup' || live)
  const [batchMode, setBatchMode] = useState<TaskBatchMode>('separate')
  const projects = useApp((s) => s.projects)
  const connection = useApp((s) => s.status)
  const providers = useComposer((s) => s.providers)
  const settings = useComposer((s) => s.settings)
  const accounts = useComposer((s) => s.accounts)
  const loading = useComposer((s) => s.providersLoading)
  const available = useMemo(() => providers.filter((p) => p.available), [providers])
  const [projectId, setProjectId] = useState(single?.project_id ?? projects[0]?.id ?? '')
  const project = projects.find((p) => p.id === projectId)
  const [choices, setChoices] = useState<SendPrefs>(() => load<Record<string, SendPrefs>>(SEND_KEY, {})[projectId || 'global'] ?? {})
  const fallback = available.find((p) => p.kind === settings?.default_provider) ?? available[0]
  const provider = followup
    ? run!.provider
    : choices.provider && available.some((p) => p.kind === choices.provider!.kind)
      ? choices.provider
      : fallback
        ? { kind: fallback.kind, instance: 'default' }
        : null
  const status = available.find((p) => p.kind === provider?.kind)
  const preferred = choices.permissionMode ?? settings?.default_permission_mode ?? 'supervised'
  const permission =
    status && !status.supported_permission_modes.includes(preferred) ? (status.supported_permission_modes[0] ?? preferred) : preferred
  const model = followup ? run?.model : choices.model
  const worktree = !!project?.is_git && (choices.useWorktree ?? true)
  const [branches, setBranches] = useState<GitBranchesResult | null>(null)
  const [notes, setNotes] = useState(() => [
    ...new Set(picked.flatMap((task) => [...task.note_ids, ...(task.source_note_id ? [task.source_note_id] : [])])),
  ])
  const needsProject = picked.some((task) => task.scope === 'global')
  const incompatible = batchMode === 'combined' && new Set(picked.map((task) => task.project_id ?? projectId)).size > 1
  useEffect(() => {
    if (connection === 'open') ensureLoaded()
  }, [connection])
  useEffect(() => {
    let current = true
    setBranches(null)
    if (projectId && project?.is_git)
      void getClient()
        ?.call('git.branches', { project_id: projectId })
        .then((result) => {
          if (current) setBranches(result)
        })
        .catch(() => {})
    return () => {
      current = false
    }
  }, [projectId, project?.is_git])
  const send = async (message: UserMessage) => {
    const client = getClient()
    if (!client) throw new Error('Reconnect and try again.')
    if (followup && single) {
      const result = await client.call('tasks.items.followup', { id: single.id, message })
      upsert(result.task)
      toast(
        result.sent_to ? (live ? `Queued for Run ${run!.number}` : `Sent to Run ${run!.number}`) : 'Saved for the next run',
        result.sent_to ? { action: { label: 'Open', onClick: () => openThread(result.sent_to!) } } : {},
      )
      setTasks({ composer: null })
      return
    }
    if (!provider) throw new Error('Install a coding agent, then try again.')
    if (needsProject && !projectId) throw new Error('Choose a project to run these tasks in.')
    if (incompatible) throw new Error('Combined tasks must belong to the same project. Choose separate runs.')
    const pending = single?.pending_followup?.trim()
    const runMessage = pending ? { ...message, parts: [{ type: 'text' as const, text: pending }, ...message.parts] } : message
    const common = {
      provider,
      model,
      effort: choices.effort,
      permission_mode: permission,
      use_worktree: worktree,
      base_branch: worktree ? choices.baseBranch : null,
      project_id: projectId || null,
      message: runMessage,
      note_ids: notes,
    }
    if (single) {
      const result = await client.call('tasks.items.send', { id: single.id, ...common })
      upsert(result.task)
      toast(`${single.key} started`, { action: { label: 'Open', onClick: () => openThread(result.thread_id) } })
    } else {
      const result = await client.call('tasks.items.send_batch', { ids, mode: batchMode, ...common })
      result.started.forEach(({ task }) => upsert(task))
      if (!result.started.length)
        throw new Error(
          result.skipped.map((item) => `${taskState().tasks[item.id]?.key ?? item.id}: ${item.reason}`).join('\n') || 'No tasks started.',
        )
      const first = result.started[0]!
      toast(`${result.started.length} tasks started`, {
        description: result.skipped.map((item) => `${taskState().tasks[item.id]?.key ?? item.id}: ${item.reason}`).join('\n') || undefined,
        action: { label: 'Open', onClick: () => openThread(first.thread_id) },
      })
      setTasks({ selected: new Set(result.skipped.map((item) => item.id)) })
    }
    save(SEND_KEY, {
      ...load<Record<string, SendPrefs>>(SEND_KEY, {}),
      [projectId || 'global']: { ...choices, provider, permissionMode: permission },
    })
    setTasks({ composer: null })
  }
  // `TaskRunDock` panels: switching between a new run and a follow-up fades the run options in over 180 ms and out over 100 ms.
  const switched = useRef(false)
  const wasFollowup = useRef(followup)
  if (wasFollowup.current !== followup) { wasFollowup.current = followup; switched.current = true }
  const panelIn = switched.current && PATCHED_NATIVE ? { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: REDUCED_MOTION ? DURATION.quick : 0.18, ease: [...EASE.out] as [number, number, number, number] } } : undefined
  return (
    <div
      testId="task-run-composer"
      style={{
        display: 'flex',
        flexDirection: 'column',
        padding: 16,
        gap: 10,
        borderTopWidth: 1,
        borderColor: t.borderLight,
        flexShrink: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ display: 'flex', flexGrow: 1, minWidth: 0 }}>
          <SwapOnChange active={followup ? 'followup' : single ? 'single' : 'batch'} style={{ justifyContent: 'flex-start' }}>
            <Label color={t.text} size={13}>
              {followup ? `Follow up on ${single!.key}` : single ? `Send ${single.key} to an agent` : `Send ${picked.length} tasks to an agent`}
            </Label>
          </SwapOnChange>
        </div>
        {single && run && !live && (
          <Button onClick={() => setKind(kind === 'run' ? 'followup' : 'run')}>{kind === 'run' ? 'Follow up' : 'New run'}</Button>
        )}
        <Button testId="task-composer-close" onClick={() => setTasks({ composer: null })}>
          Hide
        </Button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {picked.map((task) => <Button key={task.id} testId={`task-run-reference-${task.id}`} onClick={() => openTask(task.id)}>{`${task.key} · ${task.title}`}</Button>)}
      </div>
      {!followup && single?.pending_followup?.trim() && <div testId="task-pending-followup" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Label color={t.textSecondary} size={12} truncate style={{ flexGrow: 1 }}>{`Next run includes: ${single.pending_followup.trim()}`}</Label>
        <Button onClick={() => void updateTask(single.id, { pending_followup: '' }).catch(() => {})}>Clear</Button>
      </div>}
      <Presence show={!followup} enter={panelIn} exit={{ to: { opacity: 0 }, duration: 0.1, ease: EASE.out }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          {needsProject && (
            <Select
              testId="task-run-project"
              label="Run in"
              value={projectId}
              onChange={(id) => {
                setProjectId(id)
                setChoices(load<Record<string, SendPrefs>>(SEND_KEY, {})[id] ?? {})
              }}
              options={projects.map((p) => ({ value: p.id, label: p.name }))}
            />
          )}
          {project?.is_git && (
            <>
              <Select
                testId="task-run-workspace"
                label="Workspace"
                value={worktree ? 'worktree' : 'checkout'}
                onChange={(value) => setChoices({ ...choices, useWorktree: value === 'worktree' })}
                options={[
                  { value: 'worktree', label: 'New worktree' },
                  { value: 'checkout', label: 'Local checkout' },
                ]}
              />
              {worktree && (
                <Select
                  label="Base branch"
                  value={choices.baseBranch ?? ''}
                  onChange={(value) => setChoices({ ...choices, baseBranch: value || null })}
                  options={[
                    { value: '', label: branches?.current ?? 'Current branch' },
                    ...(branches?.branches ?? []).map((branch) => ({ value: branch.name, label: branch.name })),
                  ]}
                />
              )}
            </>
          )}
          {!single && (
            <Segmented
              label="Run tasks"
              value={batchMode}
              onChange={(value) => setBatchMode(value as TaskBatchMode)}
              options={[
                { value: 'separate', label: 'Separate runs' },
                { value: 'combined', label: 'One run' },
              ]}
              width={100}
            />
          )}
        </div>
      </Presence>
      {!followup && notes.length > 0 && (
        <div style={{ display: 'flex', gap: 8 }}>
          <Label color={t.textSecondary} size={12}>{`${notes.length} linked ${notes.length === 1 ? 'note' : 'notes'} included`}</Label>
          <Button onClick={() => setNotes([])}>Remove notes</Button>
        </div>
      )}
      {incompatible && !followup && (
        <Label color={t.red} size={12}>
          Choose separate runs for tasks in different projects.
        </Label>
      )}
      <ComposerView
        key={followup ? 'followup' : 'run'}
        draftKey={single ? `${followup ? 'task-followup' : 'task'}:${single.id}` : `task-batch:${ids.join(',')}`}
        projectId={projectId || undefined}
        currentThreadId={followup ? run?.thread_id : undefined}
        placeholder={
          followup
            ? 'Ask for follow-up changes…'
            : single
              ? `Tell an agent what to do with ${single.key}…`
              : 'Tell an agent what to do with these tasks…'
        }
        onSend={send}
        sendDisabled={!followup && (incompatible || (needsProject && !projectId))}
        provider={provider}
        providers={available}
        accounts={accounts}
        mode={permission}
        onModeChange={(permissionMode) => setChoices({ ...choices, permissionMode })}
        model={model}
        effort={choices.effort}
        onModelChange={followup ? undefined : async (model, effort) => setChoices({ ...choices, model, effort })}
        onProviderChange={
          followup
            ? undefined
            : async (provider, choice) => setChoices({ ...choices, provider, model: choice?.model, effort: choice?.effort })
        }
        catalogLoading={loading}
        onReloadModels={async (force) => {
          await loadProviders(force, projectId || undefined)
        }}
      />
    </div>
  )
}
