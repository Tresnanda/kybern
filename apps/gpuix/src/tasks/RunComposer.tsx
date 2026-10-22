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
import { Segmented } from '../kit/Segmented.tsx'
import { getClient, useApp } from '../state.ts'
import { load, save } from '../shell/persist.ts'
import { toast } from '../shell/toasts.tsx'
import { Label, ProviderMark, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { BranchTrayChip, parentPath, ProjectPickChip, TrayFrame, WorkspaceTrayChip } from '../composer/Tray.tsx'
import { ContextChip, runState, TrayButton, TrayHide } from './DockParts.tsx'
import { DURATION, EASE } from '../motion/tokens.ts'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { setTasks, taskState, upsert, useTasks, updateTask } from './store.ts'

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
export function RunComposer({ ids, onEmptyChange }: { ids: string[]; onEmptyChange?: (empty: boolean) => void }) {
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
  // `TaskRunDock` panels: switching between a new run and a follow-up fades the tray's contents in over 180 ms and out over 100 ms.
  const switched = useRef(false)
  const wasFollowup = useRef(followup)
  if (wasFollowup.current !== followup) { wasFollowup.current = followup; switched.current = true }
  const panelIn = switched.current && PATCHED_NATIVE ? { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: REDUCED_MOTION ? DURATION.quick : 0.18, ease: [...EASE.out] as [number, number, number, number] } } : undefined
  const hide = <TrayHide testId="task-composer-close" onClick={() => setTasks({ composer: null })} />
  const pendingText = !followup ? single?.pending_followup?.trim() : ''
  const lineStyle = { display: 'flex', alignItems: 'center', gap: 6, width: '93.33%', minHeight: 24, paddingBottom: 6 } as const
  return (
    <div testId="task-run-composer" style={{ display: 'flex', flexDirection: 'column', width: '100%', maxWidth: 660, flexShrink: 0 }}>
      <ComposerView
        key={followup ? 'followup' : 'run'}
        onEmptyChange={onEmptyChange}
        above={
          <>
            <div style={{ display: 'flex', flexDirection: 'column', width: '93.33%' }}>
              {pendingText && (
                <div testId="task-pending-followup" style={lineStyle}>
                  <Label color={t.textTertiary} size={12} truncate style={{ flexGrow: 1 }}>{`Next run includes: ${pendingText}`}</Label>
                  <TrayButton label="Clear" onClick={() => void updateTask(single!.id, { pending_followup: '' }).catch(() => {})} />
                </div>
              )}
              {!followup && notes.length > 0 && (
                <div style={lineStyle}>
                  <Label color={t.textTertiary} size={12} style={{ flexGrow: 1 }}>{`${notes.length} linked ${notes.length === 1 ? 'note' : 'notes'} included`}</Label>
                  <TrayButton label="Remove notes" onClick={() => setNotes([])} />
                </div>
              )}
              {!followup && !single && (
                <div style={lineStyle}>
                  <Segmented
                    size="sm"
                    tone="neutral"
                    aria-label="Run tasks"
                    value={batchMode}
                    onChange={(value) => setBatchMode(value as TaskBatchMode)}
                    options={[
                      { value: 'separate', label: 'Separate runs' },
                      { value: 'combined', label: 'One run' },
                    ]}
                  />
                </div>
              )}
              {incompatible && !followup && (
                <div style={lineStyle}>
                  <Label color={t.red} size={12}>Choose separate runs for tasks in different projects.</Label>
                </div>
              )}
            </div>
            <TrayFrame testId="task-dock-tray">
              <div key={followup ? 'followup' : 'run'} paintTransform={panelIn} style={{ display: 'flex', alignItems: 'center', gap: 6, flexGrow: 1, minWidth: 0 }}>
                {single ? <ContextChip task={single} /> : <Label color={t.textSecondary} size={13} lineHeight={18} style={{ paddingLeft: 8, paddingRight: 8, flexShrink: 0 }}>{`${picked.length} tasks`}</Label>}
                {followup && run && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingLeft: 8, paddingRight: 8, flexShrink: 1, minWidth: 0 }}>
                    <ProviderMark kind={run.provider.kind} size={13} />
                    <Label color={t.textSecondary} size={13} lineHeight={18} truncate>{`Run ${run.number} · ${runState(run, single!)}`}</Label>
                  </div>
                )}
                {!followup && needsProject && <ProjectPickChip projectId={projectId || null} projects={projects} onPick={(id) => { setProjectId(id); setChoices(load<Record<string, SendPrefs>>(SEND_KEY, {})[id] ?? {}) }} />}
                {!followup && project?.is_git && (
                  <WorkspaceTrayChip useWorktree={worktree} isGit checkoutHint={parentPath(project.path)} onChange={(useWorktree) => setChoices({ ...choices, useWorktree })} />
                )}
                {!followup && project?.is_git && worktree && (
                  <BranchTrayChip
                    branches={branches}
                    baseBranch={choices.baseBranch}
                    useWorktree
                    onOpen={() => {}}
                    onBranch={(baseBranch) => setChoices({ ...choices, baseBranch })}
                    onWorktree={(useWorktree) => setChoices({ ...choices, useWorktree })}
                  />
                )}
                <div style={{ flexGrow: 1 }} />
                {single && run && !live && (
                  <TrayButton
                    label={kind === 'run' ? 'Follow up' : 'New run'}
                    tip={kind === 'run' ? 'Follow up on the last run instead' : 'Start a new run instead of following up'}
                    onClick={() => setKind(kind === 'run' ? 'followup' : 'run')}
                  />
                )}
                {hide}
              </div>
            </TrayFrame>
          </>
        }
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
