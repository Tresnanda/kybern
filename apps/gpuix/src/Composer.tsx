import { clipboardAttachments, type ClipboardImage } from './composer/clipboard.ts'
import { StatusGlyph } from './composer/StatusGlyph.tsx'
import { DecoratedTextarea } from './native/decorated-input.tsx'
import { referenceDecorations } from './native/input-marks.ts'
import { nativeCapabilities, type InputSelection } from './native/api.ts'
export { useComposerOverlayHeight, useMeasureComposerOverlay } from './composer/height.ts'
import { useMeasureComposerOverlay } from './composer/height.ts'
import { createCoordinatorStarter } from '../../../packages/kybern-client/src/coordinator.ts'
import { openThread } from './nav/history.ts'
import { activeEnvironment } from './shell/environment.ts'
import { Tip } from './nav/overlay.tsx'
import { onEnvironmentChange, onEnvironmentLeaving } from './shell/environment.ts'
import { load as loadEnvironmentPreference, save as saveEnvironmentPreference } from './shell/persist.ts'
// The composer (`views/Composer.tsx`, `composerPickerStyles.ts`): a 19.2px-radius
// card with the editor on top and a footer of 28px chips (+ menu, permission
// mode, model and effort), then the 32px round send button, which becomes the
// stop control while the thread runs. Queued follow-ups stack above the card.
//
// `ThreadComposer` and `DraftComposer` wire it the way `views/Thread.tsx` and
// `views/Draft.tsx` do; the pickers and data live in `src/composer/`.
import { useGpuixRequired, type PublicInstance } from '@gpuix/react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { formatEffort, PROVIDER_LABEL } from '@/lib/format'
import { nextAttachmentLabel, type AttachmentReference } from '../../../packages/kybern-client/src/composerTokens.ts'
import { findModel, modelQualifier, selectedVariant, selectorEffort, triggerTraits, variantSelector } from '../../../packages/kybern-client/src/models.ts'
import { promptText } from '../../../packages/kybern-client/src/prompts.ts'
import {
  isFreeChatProject,
  type ContentPart,
  type PermissionMode,
  type ProjectId,
  type ProviderInstance,
  type ProviderKind,
  type ProviderStatus,
  type Thread,
  type UserMessage,
} from '../../../packages/kybern-client/src/types.ts'
import { Icon } from './icons.tsx'
import { MatrixLoader } from './MatrixLoader.tsx'
import { getClient, setThreadOpen, usePaneCompact, focusPane, getFocusedPaneId, usePaneAccess, getPane, selectPaneThread, setPane, set, useApp } from './state.ts'
import { FONT_UI } from './theme.ts'
import { ink, Label, useTheme } from './ui.tsx'
import { addWindowKeyHandler } from './nav/keys.ts'
import { keyboardAnswer } from './requests/Panel.tsx'
import { isUserInput, connectorApproval } from '../../../packages/kybern-client/src/userInput.ts'
import { answerApproval } from './transcript/Requests.tsx'
import { FooterChip } from './composer/chips.tsx'
import { G } from './composer/glyphs.ts'
import { muted, PickerItem, PickerMenu } from './composer/Menu.tsx'
import { useCompletion } from './composer/Completion.tsx'
import { ModelPicker, ModelTriggerLabel } from './composer/ModelPicker.tsx'
import { PermissionPicker } from './composer/PermissionPicker.tsx'
import { Pop, SwapOnChange } from './composer/motion.tsx'
import { Rise } from './motion/kit.tsx'
import {
  createThread,
  ensureLoaded,
  errorText,
  getData,
  interruptThread,
  loadCatalog,
  loadProviders,
  loadQueue,
  loadTarget,
  patch,
  patchDraft,
  removeQueued,
  sendToThread,
  setThreadMode,
  setThreadModel,
  uploadPath,
  uploadBytes,
  useComposer,
} from './composer/store.ts'

export const COMPOSER_RADIUS = 19.2
const DEFAULT_PLACEHOLDER = 'Ask anything, @ to mention, $ skills, or / commands'
/** Agents whose running turn accepts steering (`views/Thread.tsx:388`). */
const STEERABLE = ['claude-code', 'codex', 'pi', 'omp']

export function Composer({ thread, tray }: { thread: Thread | null; tray?: ReactNode }) {
  const status = useApp((s) => s.status)
  useEffect(() => {
    if (status === 'open') ensureLoaded()
  }, [status])
  // The open transcript folds `thread_updated` events, so its copy carries the
  // live status; the thread list only refreshes on `projects`/list changes.
  const live = useApp((s) => (!thread ? null : s.open.thread?.id === thread.id ? s.open.thread : s.threads.find((th) => th.id === thread.id) ?? thread))
  return live ? <ThreadComposer key={live.id} thread={live} /> : <DraftComposer tray={tray} />
}

// ---- wiring: an open thread ----

function ThreadComposer({ thread }: { thread: Thread }) {
  const pane = usePaneAccess()
  const threadId = thread.id
  const running = thread.status === 'running' || thread.status === 'awaiting-approval'
  const target = useComposer((d) => (d.target?.threadId === threadId ? d.target.state : null))
  const providers = useComposer((d) => d.providers)
  const accounts = useComposer((d) => d.accounts)
  const catalog = useComposer((d) => d.catalog)
  const catalogLoading = useComposer((d) => d.catalogLoading)
  const queued = useComposer((d) => d.queued[threadId])
  const approval = useApp((s) => (s.open.thread?.id === threadId ? s.open.pendingApprovals[0] : null))
  const projectName = useApp(s => s.projects.find(p => p.id === thread.coordinator_project_id)?.name)

  useEffect(() => {
    if (!pane.frozen) void loadTarget(threadId)
  }, [threadId, thread.status, thread.provider.instance, thread.model, pane.frozen])
  useEffect(() => {
    if (!pane.frozen) void loadQueue(threadId)
  }, [threadId, running, pane.frozen])

  const provider = target?.target.provider ?? thread.provider
  const catalogKey = `${threadId}:${provider.kind}:${provider.instance}`
  useEffect(() => {
    if (!pane.frozen) void loadCatalog(threadId, provider, thread.project_id, false).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogKey, thread.project_id, pane.frozen])
  const composerProviders = useMemo(
    () => providers.map((status) => (status.kind === provider.kind && catalog?.key === catalogKey ? catalog.status : status)),
    [providers, provider.kind, catalog, catalogKey],
  )
  const targetChanged = !!target && (target.target.provider.kind !== thread.provider.kind || target.target.provider.instance !== thread.provider.instance)
  const mode = targetChanged ? target?.pending_permission_mode ?? thread.permission_mode : thread.permission_mode
  const coordinator = !!thread.coordinator_project_id
  const handoffSelected =
    !!target && (targetChanged || (target.target.model ?? null) !== (thread.model ?? null) || (target.target.effort ?? null) !== (thread.effort ?? null))
  const chooseTarget = async (next: ProviderInstance, model?: string, effort?: string, inherit = !target?.account_override) => {
    const state = await getClient()!.call('threads.target.set', { thread_id: threadId, target: { provider: next, model, effort }, inherit_account: inherit })
    patch({ target: { threadId, state } })
  }

  const switchHarness = async (next: ProviderInstance, model?: string, effort?: string) => {
    if (running) throw new Error("Finish or stop the Coordinator's current turn before changing its harness.")
    const available = providers.find(p => p.kind === next.kind && p.available)
    if (!available) throw new Error('Choose an available harness for the Coordinator.')
    const modes = available.supported_permission_modes
    const permission = modes.includes(thread.permission_mode) ? thread.permission_mode : modes.includes('supervised') ? 'supervised' : modes[0]
    if (!permission) throw new Error('This harness does not expose a supported permission mode.')
    const owner = activeEnvironment()
    const switched = await getClient()!.call('coordinator.switch_harness', { project_id: thread.coordinator_project_id!, provider: next, model, effort, permission_mode: permission })
    if (owner !== activeEnvironment()) return
    const state = pane.get()
    set({ threads: state.threads.map(t => t.id === switched.id ? switched : t) })
    if (state.open.thread?.id === switched.id) setThreadOpen(switched.id, { ...state.open, thread: switched })
    await loadTarget(switched.id)
  }

  return (
    <ComposerView
      draftKey={`thread:${threadId}`}
      projectId={isFreeChatProject(thread.project_id) ? undefined : thread.project_id}
      currentThreadId={threadId}
      placeholder={
        approval
          ? isUserInput(approval) && !connectorApproval(approval) ? 'Answer the questions above' : 'Resolve this approval request to continue'
          : running
            ? 'Ask for follow-up changes'
            : coordinator
              ? `What should we work on in ${projectName ?? 'this project'}?`
              : undefined
      }
      running={running}
      onStop={() => void interruptThread(threadId).catch(() => {})}
      onSend={(message, delivery) => sendToThread(threadId, message, delivery)}
      canSteer={handoffSelected || STEERABLE.includes(thread.provider.kind)}
      mode={mode}
      onModeChange={(m) => void setThreadMode(threadId, m).catch((e) => console.error('Unable to change mode:', errorText(e)))}
      provider={provider}
      providers={composerProviders}
      accounts={accounts}
      accountFollowsDefaults={target ? !target.account_override : undefined}
      onAccountChange={coordinator ? running ? undefined : (instance) => switchHarness({ ...provider, instance: instance ?? 'default' }, thread.model ?? undefined, thread.effort ?? undefined) : (instance) => chooseTarget({ ...provider, instance: instance ?? 'default' }, target?.target.model ?? undefined, target?.target.effort ?? undefined, instance === null)}
      model={target?.target.model ?? thread.model ?? undefined}
      effort={target?.target.effort ?? thread.effort ?? undefined}
      onModelChange={coordinator ? running ? undefined : (model, effort) => switchHarness(provider, model, effort) : (model, effort) => setThreadModel(threadId, model, effort)}
      onProviderChange={coordinator ? running ? undefined : (next, choice) => switchHarness(next, choice?.model, choice?.effort) : (next, choice) => chooseTarget(next, choice?.model, choice?.effort, !choice?.pinAccount)}
      catalogLoading={catalogLoading === catalogKey}
      onReloadModels={(force) => loadCatalog(threadId, provider, thread.project_id, force).then(() => {})}
      above={queued?.length ? <QueuedPanel threadId={threadId} items={queued.map((q) => ({ id: q.id, message: q.message }))} /> : null}
    />
  )
}

// ---- wiring: the home screen ----

/** The draft's agent, as `views/Draft.tsx:55-66` picks it. */
export function useDraftTarget() {
  const draft = useComposer((d) => d.draft)
  const settings = useComposer((d) => d.settings)
  const providers = useComposer((d) => d.providers)
  const projects = useApp((s) => s.projects)
  // The most recently active thread's project, or the first project.
  const recentProject = useApp((s) => s.threads.find((th) => s.projects.some((p) => p.id === th.project_id))?.project_id ?? s.projects[0]?.id)
  const entry = useApp(s => s.draft)
  const projectId = entry.projectId ? entry.projectId : draft.projectId === undefined ? recentProject ?? null : draft.projectId
  const project = projectId ? projects.find((p) => p.id === projectId) : undefined
  const available = useMemo(() => providers.filter((p) => p.available), [providers])
  const provider = useMemo<ProviderInstance | null>(() => {
    const stored = draft.provider
    const instanceFor = (kind: ProviderKind) => {
      const config = settings?.providers[kind]
      return (project ? config?.project_accounts?.[project.path] : undefined) ?? config?.default_account ?? 'default'
    }
    if (stored && available.some((p) => p.kind === stored.kind)) {
      if (stored.pinAccount || stored.instance !== 'default') return stored
      return { kind: stored.kind, instance: instanceFor(stored.kind) }
    }
    const pick = available.find((p) => p.kind === settings?.default_provider) ?? available[0]
    return pick ? { kind: pick.kind, instance: instanceFor(pick.kind) } : null
  }, [draft.provider, available, settings, project])
  const pinAccount = !!draft.provider && (draft.provider.pinAccount ?? draft.provider.instance !== 'default')
  const preferred = draft.mode ?? settings?.default_permission_mode ?? 'supervised'
  const status = provider ? available.find((p) => p.kind === provider.kind) : undefined
  const mode: PermissionMode = status && !status.supported_permission_modes.includes(preferred) ? status.supported_permission_modes[0] ?? preferred : preferred
  const useWorktree = !projectId ? false : draft.worktree ?? project?.worktrees_default ?? settings?.worktrees_default ?? false
  return { draft, projectId, project, provider, pinAccount, mode, status, useWorktree, choice: provider ? draft.models[provider.kind] : undefined }
}

function DraftComposer({ tray }: { tray?: ReactNode }) {
  const pane = usePaneAccess()
  const providers = useComposer((d) => d.providers)
  const loading = useComposer((d) => d.providersLoading)
  const accounts = useComposer((d) => d.accounts)
  const { projectId, provider, pinAccount, mode, useWorktree, choice, draft } = useDraftTarget()
  const coordinator = useApp(s => s.draft.purpose === 'coordinator')
  const starter = useRef<{ client: ReturnType<typeof getClient>; controller: ReturnType<typeof createCoordinatorStarter> } | null>(null)

  return (
    <ComposerView
      key={`${coordinator ? 'coordinator' : 'project'}:${projectId ?? 'free'}`}
      draftKey={`${coordinator ? 'coordinator' : 'project'}:${projectId ?? 'free'}`}
      placeholder={coordinator ? 'Describe the outcome, constraints, and what success looks like' : undefined}
      projectId={projectId ?? undefined}
      above={tray}
      mode={mode}
      onModeChange={(m) => patchDraft({ mode: m })}
      provider={provider}
      providers={providers}
      accounts={accounts}
      model={choice?.model}
      effort={choice?.effort}
      onModelChange={async (model, effort) => {
        if (provider) patchDraft({ models: { ...getData(pane.id).draft.models, [provider.kind]: { model, effort } } })
      }}
      onProviderChange={async (next, nextChoice) => {
        const models = nextChoice ? { ...getData(pane.id).draft.models, [next.kind]: nextChoice } : getData(pane.id).draft.models
        const nextStatus = getData().providers.find((item) => item.kind === next.kind)
        const keepMode = !nextStatus || nextStatus.supported_permission_modes.includes(mode)
        patchDraft({
          provider: { ...next, pinAccount: nextChoice?.pinAccount ?? next.instance !== 'default' },
          models,
          ...(keepMode ? {} : { mode: nextStatus!.supported_permission_modes.includes('supervised') ? 'supervised' : nextStatus!.supported_permission_modes[0] ?? mode }),
        })
      }}
      catalogLoading={loading}
      onReloadModels={(force) => loadProviders(force, projectId ?? undefined).then(() => {})}
      sendDisabled={!provider || (coordinator && !projectId)}
      sendDisabledReason={!provider ? 'Choose an available agent before sending.' : coordinator && !projectId ? 'Choose a project for the Coordinator.' : undefined}
      onSend={async (message) => {
        if (!provider) return
        if (coordinator) {
          const client = getClient()!, owner = activeEnvironment(), generation = getPane(pane.id)?.generation
          const available = providers.find(p => p.kind === provider.kind && p.available)
          if (!projectId || !available) throw new Error('Choose a project and an available harness.')
          if (starter.current?.client !== client) starter.current = { client, controller: createCoordinatorStarter((method, params) => client.call(method, params), () => crypto.randomUUID()) }
          const result = await starter.current.controller.send({ projectId, provider: available, instance: provider.instance, model: choice?.model, effort: choice?.effort, permissionMode: mode }, message)
          if (owner === activeEnvironment() && getPane(pane.id)?.generation === generation) { const state = pane.get(); set({ threads: [...state.threads.filter(t => t.id !== result.thread.id), result.thread] }); void selectPaneThread(pane.id, result.thread.id) }
          return
        }
        await createThread({
          paneId: pane.id,
          projectId,
          provider: pinAccount ? provider : { ...provider, instance: 'default' },
          pinAccount,
          permissionMode: mode,
          model: choice?.model,
          effort: choice?.effort,
          useWorktree,
          baseBranch: draft.baseBranch ?? undefined,
          message,
        })
      }}
    />
  )
}

// ---- the shell ----

interface Attachment {
  id: string
  name: string
  media_type: string
  size: number
  /** Inline label (`image1`) the prompt can mention as `@image1`. */
  label: string
  path: string
}

/**
 * A model id the catalog has not listed yet (it loads a few seconds after
 * launch): `claude-fable-5-1` reads "Claude Fable 5.1", as the desktop's
 * fallback comment in `views/Composer.tsx` intends; other ids show as they are.
 */
function uncataloguedName(model: string): string {
  const claude = model.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{6,})?$/)
  if (!claude) return model
  return `Claude ${claude[1]![0]!.toUpperCase()}${claude[1]!.slice(1)} ${claude[2]}${claude[3] ? `.${claude[3]}` : ''}`
}

/** Text and attachments kept per thread or project while the composer is away (`composerDrafts`). */
const drafts = new Map<string, { text: string; attachments: Attachment[] }>(loadEnvironmentPreference('kybern.composer.drafts', []))
onEnvironmentLeaving(() => saveEnvironmentPreference('kybern.composer.drafts', [...drafts].slice(-100)))
onEnvironmentChange(() => { drafts.clear(); for (const [key, value] of loadEnvironmentPreference<[string, { text: string; attachments: Attachment[] }][] >('kybern.composer.drafts', [])) drafts.set(key, value) })

export interface ComposerViewProps {
  draftKey: string
  /** Enables @ files and the skill catalog (`views/Composer.tsx` `projectId`). */
  projectId?: ProjectId
  currentThreadId?: string
  placeholder?: string
  running?: boolean
  onStop?: () => void
  onSend: (message: UserMessage, delivery: 'send' | 'queue' | 'steer') => Promise<void>
  canSteer?: boolean
  sendDisabled?: boolean
  sendDisabledReason?: string
  readOnly?: boolean
  lockMode?: boolean
  mode: PermissionMode
  onModeChange: (mode: PermissionMode) => void
  provider: ProviderInstance | null
  providers: ProviderStatus[]
  accounts: import('../../../packages/kybern-client/src/types.ts').AccountSummary[]
  accountFollowsDefaults?: boolean
  onAccountChange?: (instance: string | null) => Promise<void>
  model?: string | null
  effort?: string | null
  onModelChange?: (model: string | undefined, effort: string | undefined) => Promise<void>
  onProviderChange?: (provider: ProviderInstance, choice?: { model?: string; effort?: string; pinAccount?: boolean }) => Promise<void>
  catalogLoading: boolean
  onReloadModels: (force: boolean) => Promise<void>
  above?: ReactNode
}

export function ComposerView(input: ComposerViewProps) {
  const compact = usePaneCompact()
  const pane = usePaneAccess()
  const props = { ...input, draftKey: `${pane.id}:${input.draftKey}`, readOnly: input.readOnly || pane.frozen }
  const measureOverlay = useMeasureComposerOverlay()
  const t = useTheme()
  const renderer = useGpuixRequired()
  const { running, provider, providers, model, effort, mode } = props
  const connected = useApp((s) => s.status === 'open')
  const saved = drafts.get(props.draftKey)
  const [text, setText] = useState(saved?.text ?? '')
  const [attachments, setAttachments] = useState<Attachment[]>(saved?.attachments ?? [])
  const [uploading, setUploading] = useState(0)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)
  const pastePending = useRef(false)
  const [promptMode, setPromptMode] = useState<'queue' | 'steer'>('queue')
  const [changingModel, setChangingModel] = useState(false)
  const editor = useRef<PublicInstance | null>(null)
  const card = useRef<PublicInstance | null>(null)
  const [selection, setSelection] = useState<InputSelection>({ start: text.length, end: text.length, reversed: false, composing: false })
  const readSelection = () => {
    if (!editor.current) return
    const next = nativeCapabilities(renderer).getInputSelection(editor.current.id)
    setSelection(old => old.start === next.start && old.end === next.end && old.composing === next.composing && old.reversed === next.reversed ? old : next)
  }
  const edit = (start: number, end: number, replacement: string) => {
    if (!editor.current || props.readOnly) return false
    try {
      nativeCapabilities(renderer).editInput(editor.current.id, { start, end, text: replacement, expectedValue: text })
      readSelection()
      focusEditor()
      return true
    } catch (e) { setError(errorText(e)); return false }
  }
  const lastModelRefresh = useRef(0)
  const approvalDigit = useRef<string | null>(null)
  const steering = !!running && !!props.canSteer && promptMode === 'steer'

  useEffect(() => {
    if (text || attachments.length) drafts.set(props.draftKey, { text, attachments })
    else drafts.delete(props.draftKey)
    saveEnvironmentPreference('kybern.composer.drafts', [...drafts].slice(-100))
  }, [text, attachments, props.draftKey])

  // Automation: the native file picker cannot be driven, so a test run can name
  // files to attach on mount (`KYBERN_GPUIX_ATTACH=/a.png,/b.pdf`).
  useEffect(() => {
    const preset = process.env.KYBERN_GPUIX_ATTACH
    if (preset && connected) void addFiles(preset.split(','))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected])

  const empty = text.trim().length === 0 && attachments.length === 0
  const permissionUnsupported = provider?.kind !== 'cursor' && !!providers.find(p => p.kind === provider?.kind && !p.supported_permission_modes.includes(mode))
  const disabledReason = !connected ? 'Reconnect to send a message.' : props.readOnly ? 'This conversation is read-only.' : props.sendDisabled ? props.sendDisabledReason ?? 'Sending is unavailable.' : permissionUnsupported ? 'Choose a permission mode supported by this agent.' : sending ? 'Sending…' : uploading > 0 ? 'Wait for attachments to finish uploading.' : empty ? 'Write a message or attach a file.' : null
  const canSend = !disabledReason

  const focusEditor = () => {
    if (editor.current) renderer.focusElement?.(editor.current.id)
  }

  const attachmentRefs = useMemo<AttachmentReference[]>(
    () => attachments.map((a) => ({ token: `@${a.label}`, part: { type: 'attachment', asset_id: a.id, name: a.name, media_type: a.media_type, size: a.size } })),
    [attachments],
  )
  const completion = useCompletion({
    draftKey: props.draftKey,
    text,
    setText,
    caret: selection.reversed ? selection.start : selection.end,
    composing: selection.composing || selection.start !== selection.end,
    edit,
    projectId: props.projectId,
    provider: provider ?? undefined,
    currentThreadId: props.currentThreadId,
    attachments: attachmentRefs,
    commands: [{ name: 'attach', hint: 'Attach files or images', icon: G.paperclip, run: () => void addFiles() }],
  })

  // Scope approval shortcuts strictly to this editor. Native events cannot
  // prevent text insertion, so consume only the exact digit below.
  useEffect(() => addWindowKeyHandler((e) => {
    if (pane.frozen || !editor.current || renderer.getFocusedElementId?.() !== editor.current.id) return false
    const m = e.modifiers
    if (m?.cmd || m?.alt || m?.ctrl || m?.shift) return false
    if (!empty || sending || !props.currentThreadId || !/^[1-4]$/.test(e.key ?? '')) return false
    const approval = pane.get().open.pendingApprovals[0]
    if (!approval) return false
    keyboardAnswer()
    if (!answerApproval(approval, props.currentThreadId, Number(e.key))) return false
    approvalDigit.current = e.key!
    // GPUIX 0.10 delivers events asynchronously and cannot prevent native text
    // insertion. Remove only the exact consumed digit, never subsequent typing.
    setTimeout(() => {
      setText((value) => value === e.key ? '' : value)
      approvalDigit.current = null
    }, 0)
    return true
  }), [renderer, completion, empty, sending, props.currentThreadId])

  const buildParts = (): ContentPart[] => {
    const parts = completion.buildParts()
    // Attachments the prompt never mentions keep their place at the end.
    const placed = new Set(parts.flatMap((part) => (part.type === 'attachment' ? [part.asset_id] : [])))
    for (const r of attachmentRefs) if (r.part.type === 'attachment' && !placed.has(r.part.asset_id)) parts.push(r.part)
    return parts
  }

  const submit = async (delivery: 'queue' | 'steer' = promptMode) => {
    if (!canSend || (editor.current && nativeCapabilities(renderer).getInputSelection(editor.current.id).composing)) return
    const status = provider ? providers.find((p) => p.kind === provider.kind) : undefined
    if (status && provider?.kind !== 'cursor' && !status.supported_permission_modes.includes(mode)) {
      setError('Choose a supported permission mode for the selected agent before sending.')
      return
    }
    setSending(true)
    setError(null)
    try {
      await props.onSend({ parts: buildParts() }, running ? (delivery === 'steer' && props.canSteer ? 'steer' : 'queue') : 'send')
      setText('')
      setAttachments([])
      completion.reset()
      drafts.delete(props.draftKey)
      focusEditor()
    } catch (e) {
      setError(`Unable to send: ${errorText(e)}`)
    } finally {
      setSending(false)
    }
  }

  const addClipboardImage = async (image: ClipboardImage) => {
    setUploading((n) => n + 1)
    setError(null)
    const name = image.name ?? 'pasted-image.png'
    try {
      const info = await uploadBytes(name, image.mediaType, image.data)
      // Native images accept data URIs, so previews need no temporary file.
      const path = `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}`
      setAttachments((list) => [...list, { ...info, path, label: nextAttachmentLabel(info.media_type, list.map((a) => a.label)) }])
    } catch (e) { setError(`Unable to attach image: ${errorText(e)}`) }
    finally { setUploading((n) => n - 1); focusEditor() }
  }

  const addFiles = async (picked?: string[]) => {
    const paths = picked ?? (await renderer.promptForPaths?.({ files: true, multiple: true, prompt: 'Attach' }))
    if (!paths?.length) return
    setFeedback(null)
    setUploading((n) => n + paths.length)
    for (const path of paths) {
      try {
        const info = await uploadPath(path)
        setAttachments((list) => [...list, { ...info, path, label: nextAttachmentLabel(info.media_type, list.map((a) => a.label)) }])
      } catch (e) {
        setError(`Unable to attach ${path.split('/').pop()}: ${errorText(e)}`)
      } finally {
        setUploading((n) => n - 1)
      }
    }
    focusEditor()
  }

  // ---- model trigger ----
  const status = provider ? providers.find((p) => p.kind === provider.kind) : undefined
  const models = status?.models ?? []
  const current = model ? findModel(models, model) : models.find((m) => m.is_default)
  const traits = triggerTraits(current, model)
  const qualifier = modelQualifier(models, current)
  const effortLabel = effort ?? selectorEffort(current, model) ?? selectedVariant(current, model)?.default_effort ?? current?.default_effort ?? null
  const canPickModel = !!props.onModelChange
  const canReload = canPickModel && !!status?.available && status.supports_model_switch
  const canPickProvider = !!props.onProviderChange
  const busyRun = async (work: () => Promise<void>) => {
    if (changingModel) return false
    setChangingModel(true)
    try {
      await work()
      return true
    } catch (e) {
      setError(`Unable to change model: ${errorText(e)}`)
      return false
    } finally {
      setChangingModel(false)
    }
  }

  const modelName = current?.display_name ?? (model ? uncataloguedName(model) : provider ? PROVIDER_LABEL[provider.kind] : '')

  return (
    <div ref={measureOverlay} testId="composer-overlay" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%', maxWidth: 736 }}>
      {props.above}
      <div
        ref={(el) => {
          card.current = el
        }}
        testId="composer-drop-zone"
        onFileDrop={(e) => {
          if (props.readOnly || !e.paths?.length) return
          void addFiles(e.paths)
        }}
        style={{
          display: 'flex',
          flexDirection: 'column',
          width: '100%',
          borderRadius: compact ? 14 : COMPOSER_RADIUS,
          borderWidth: 1,
          borderColor: t.variant === 'dark' ? 'rgba(252, 252, 252, 0.052)' : 'rgba(13, 13, 13, 0.076)',
          backgroundColor: t.variant === 'dark' ? t.composer : '#ffffff',
          boxShadow:
            t.variant === 'dark'
              ? { offsetX: 0, offsetY: 6, blurRadius: 24, spreadRadius: -10, color: 'rgba(0, 0, 0, 0.30)' }
              : { offsetX: 0, offsetY: 4, blurRadius: 18, spreadRadius: -6, color: 'rgba(13, 13, 13, 0.07)' },
        }}
      >
        {completion.menu((card.current && renderer.getElementBounds?.(card.current.id)?.width) || 736)}
        <div style={{ display: 'flex', flexDirection: 'column', paddingTop: 14, paddingBottom: 8, paddingLeft: 16, paddingRight: 16 }}>
          {(attachments.length > 0 || uploading > 0) && (
            <Attachments
              items={attachments}
              uploading={uploading}
              onRemove={(a) => setAttachments((list) => list.filter((item) => item.id !== a.id))}
            />
          )}
          {!!completion.tokens.length && <div testId="composer-tokens" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, paddingBottom: 8 }}>
            {completion.tokens.map(token => <div key={token.token} role="button" aria-label={`Select ${token.label}`} onClick={() => {
              if (!editor.current) return
              const start = text.indexOf(token.token)
              focusEditor()
              nativeCapabilities(renderer).setInputSelection(editor.current.id, start, start + token.token.length, false)
              readSelection()
            }} style={{ padding: 4, paddingLeft: 8, paddingRight: 8, borderRadius: 6, backgroundColor: t.buttonSecondary, cursor: 'pointer' }}><Label color={t.text} size={12}>{token.label}</Label></div>)}
          </div>}
          <div style={{ position: 'relative', display: 'flex' }}>
            {/* GPUIX paints its own placeholder in a fixed grey; this one is the kit's muted × 40%. */}
            {!text && (
              <div testId="composer-placeholder" style={{ position: 'absolute', top: 0, left: 0, right: 0, pointerEvents: 'none' }}>
                <Label color={muted(t, 0.4)} lineHeight={19.6} truncate>
                  {props.placeholder ?? DEFAULT_PLACEHOLDER}
                </Label>
              </div>
            )}
            <DecoratedTextarea
              decorations={referenceDecorations(text, [...completion.tokens, ...attachmentRefs.map(r => ({ token: r.token, label: r.token.slice(1) }))], { textSecondary: t.textSecondary, accent: t.accentBlue, buttonSecondary: t.buttonSecondary })}
              ref={(el) => {
                editor.current = el
              }}
              interceptKeys={['up', 'down', 'left', 'right', 'home', 'end', 'enter', 'tab', 'escape', 'v']}
              testId="composer"
              autoFocus={!pane.frozen && getFocusedPaneId() === pane.id}
              onFocus={() => { if (!pane.frozen) focusPane(pane.id) }}
              value={text}
              readOnly={props.readOnly}
              minRows={2}
              maxRows={10}
              onClick={readSelection}
              onChange={(e) => {
                readSelection()
                setFeedback(pastePending.current ? 'Pasted text' : null)
                pastePending.current = false
                if (approvalDigit.current && e.value === approvalDigit.current) setText('')
                else setText(e.value ?? '')
                if (error) setError(null)
              }}
              onKeyDown={(e) => {
                readSelection()
                if (e.modifiers?.cmd && e.key === 'v' && !props.readOnly) {
                  try {
                    const payload = clipboardAttachments(renderer)
                    if (payload.paths.length || payload.image) {
                      e.preventDefault()
                      if (payload.paths.length) void addFiles(payload.paths)
                      else void addClipboardImage(payload.image!)
                      return
                    }
                  } catch (error) { setError(`Unable to paste: ${errorText(error)}`) }
                  pastePending.current = true
                }
                // Native navigation is applied after the key notification.
                if (['left', 'right', 'up', 'down', 'home', 'end'].includes(e.key ?? '')) setTimeout(readSelection, 32)
                // Marked IME input bypasses native interception. Do not turn
                // its ordinary key notification into a completion or send.
                if (['up', 'down', 'enter', 'tab', 'escape'].includes(e.key ?? '') && (e as typeof e & { requestId?: number }).requestId == null) return
                // ⌘↵ steers even when a completion menu is open.
                if (e.key === 'enter' && e.modifiers?.cmd && !e.modifiers.shift) {
                  e.preventDefault()
                  void submit(running ? 'steer' : promptMode)
                  return
                }
                if ((e.key === 'up' || e.key === 'down') && (e.modifiers?.cmd || e.modifiers?.alt || e.modifiers?.ctrl || e.modifiers?.shift)) return
                if (completion.onKey(e.key ?? '', !!e.modifiers?.shift, !!e.modifiers?.ctrl)) {
                  e.preventDefault()
                  return
                }
                if (e.key === 'enter' && !e.modifiers?.shift && !e.modifiers?.alt && !e.modifiers?.ctrl) {
                  e.preventDefault()
                  void submit()
                }
              }}
              onSubmit={() => { void submit() }}
              theme={{ caret: t.text }}
              style={{ width: '100%', fontSize: 14, lineHeight: 19.6, color: t.text, fontFamily: FONT_UI, opacity: connected ? 1 : 0.6 }}
            />
          </div>
          {feedback && !error && <div testId="composer-feedback"><Label color={muted(t, 0.6)} size={12}>{feedback}</Label></div>}
          {error && (
            <div style={{ display: 'flex', paddingTop: 6 }}>
              <Label color={t.red} size={12} lineHeight={16}>
                {error}
              </Label>
            </div>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4, paddingLeft: 12, paddingRight: 12, paddingBottom: 12, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 1, minWidth: 64 }}>
            <PickerMenu
              testId="composer-plus"
              side="top"
              align="start"
              trigger={(open) => (
                <FooterChip square pressed={open}>
                  {() => <Icon name="plus" size={18} color={t.text} />}
                </FooterChip>
              )}
            >
              <PickerItem id="files" testId="add-files" onSelect={() => void addFiles()}>
                <Icon source={G.paperclip} size={16} color={t.text} style={{ opacity: 0.8 }} />
                <Label color={t.text}>Add files</Label>
              </PickerItem>
            </PickerMenu>
            <PermissionPicker locked={props.lockMode} mode={mode} kind={provider?.kind} status={status} onChange={props.onModeChange} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4, flexGrow: 1, minWidth: 200 }}>
            {provider && props.currentThreadId && <StatusGlyph provider={provider} running={running} />}
            {provider && (
              <ModelPicker
                provider={provider}
                providers={providers}
                model={model}
                effort={effort}
                canPickModel={canPickModel}
                canPickProvider={canPickProvider}
                canReload={canReload}
                loading={props.catalogLoading}
                busy={changingModel}
                accounts={props.accounts}
                accountInstance={provider.instance}
                accountFollowsDefaults={props.accountFollowsDefaults}
                onAccountChange={props.onAccountChange ? (instance) => busyRun(() => props.onAccountChange!(instance)) : undefined}
                onOpenChange={(open) => {
                  // Self-heal a stale catalog without re-probing on every open.
                  if (!open || !canReload || Date.now() - lastModelRefresh.current < 60_000) return
                  lastModelRefresh.current = Date.now()
                  void props.onReloadModels(false).catch(() => {})
                }}
                onModelChange={(next, nextEffort) => busyRun(() => props.onModelChange!(next || undefined, nextEffort))}
                onEffortChange={(next) => busyRun(() => props.onModelChange!(variantSelector(current, model) ?? model ?? undefined, next))}
                onProviderChange={(next, choice) => busyRun(() => props.onProviderChange!(next, choice))}
                onReload={() => {
                  lastModelRefresh.current = Date.now()
                  void props.onReloadModels(true).catch((e) => setError(`Unable to reload models: ${errorText(e)}`))
                }}
                label={(color) => (
                  <ModelTriggerLabel
                    kind={provider.kind}
                    account={provider.instance !== 'default' ? props.accounts.find(a => a.provider.kind === provider.kind && a.provider.instance === provider.instance) ?? null : null}
                    model={modelName}
                    qualifier={qualifier}
                    fast={traits.fast}
                    effort={(current?.display_name ?? model) && effortLabel ? formatEffort(effortLabel) : null}
                    traits={traits.labels}
                    chevron={canPickModel || canReload || canPickProvider}
                    color={color}
                  />
                )}
              />
            )}
            {running && props.canSteer !== undefined && (
              <RunningControls
                sending={sending}
                steering={steering}
                canSend={canSend}
                canSteer={!!props.canSteer}
                onSubmit={() => void submit()}
                onPromptMode={setPromptMode}
              />
            )}
            {running ? (
              <RoundButton testId="stop" onClick={props.onStop}>
                <Icon source={G.stop} size={10} color={t.v('--color-background-elevated-primary-opaque')} />
              </RoundButton>
            ) : (
              <Tip label={disabledReason ?? (steering ? 'Steer now ⌘↵' : 'Send ↵')}><RoundButton testId="send" disabled={!canSend} onClick={() => void submit()}>
                {/* `IconSwap` arrow ↔ spinner while sending (`Composer.tsx:1441`); the spinner is the shared-clock loader. */}
                <SwapOnChange active={sending ? 'sending' : 'send'}>
                  {sending ? (
                    <MatrixLoader rgb={rgbOf(t.v('--color-background-elevated-primary-opaque'))} alpha={1} gap={1.5} />
                  ) : (
                    <Icon name="send" size={20} color={t.v('--color-background-elevated-primary-opaque')} />
                  )}
                </SwapOnChange>
              </RoundButton></Tip>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/** `#rrggbb` or `rgb(r, g, b)` as a tuple (the loader's dot colour on the ink button). */
function rgbOf(color: string): [number, number, number] {
  const hex = color.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i)
  if (hex) return [parseInt(hex[1]!, 16), parseInt(hex[2]!, 16), parseInt(hex[3]!, 16)]
  const [r = 0, g = 0, b = 0] = (color.match(/[\d.]+/g) ?? []).map(Number)
  return [r, g, b]
}

/** `COMPOSER_FOOTER_SEND_BUTTON_CLASS_NAME` on a `prominent` button: the ink circle, 30% when off. */
function RoundButton({ children, disabled, onClick, testId }: { children: ReactNode; disabled?: boolean; onClick?: () => void; testId: string }) {
  const t = useTheme()
  return (
    <div
      testId={testId}
      role="button"
      aria-disabled={disabled}
      onClick={disabled ? undefined : onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 32,
        height: 32,
        borderRadius: 16,
        flexShrink: 0,
        backgroundColor: t.text,
        opacity: disabled ? 0.3 : 1,
        cursor: disabled ? 'default' : 'pointer',
        active: disabled ? {} : { opacity: 0.8 },
      }}
    >
      {children}
    </div>
  )
}

/** Queue / Steer now and the delivery menu (`Composer.tsx:1364-1402`). */
function RunningControls({
  sending,
  steering,
  canSend,
  canSteer,
  onSubmit,
  onPromptMode,
}: {
  sending: boolean
  steering: boolean
  canSend: boolean
  canSteer: boolean
  onSubmit: () => void
  onPromptMode: (mode: 'queue' | 'steer') => void
}) {
  const t = useTheme()
  const [hover, setHover] = useState(false)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
      <div
        testId="queue"
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onClick={canSend ? onSubmit : undefined}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          paddingLeft: 8,
          paddingRight: 8,
          paddingTop: 2,
          paddingBottom: 2,
          borderRadius: 10,
          backgroundColor: hover && canSend ? t.buttonSecondaryHover : t.buttonSecondary,
          opacity: canSend ? 1 : 0.64,
          cursor: canSend ? 'pointer' : 'default',
        }}
      >
        <Label color={t.text} size={13} weight={500} lineHeight={18}>
          {sending ? 'Sending…' : steering ? 'Steer now' : 'Queue'}
        </Label>
      </div>
      {canSteer && (
        <PickerMenu
          testId="delivery"
          side="top"
          align="end"
          width={240}
          trigger={(open) => (
            <FooterChip square pressed={open}>
              {(color) => <Icon name="chevronDown" size={12} color={color} />}
            </FooterChip>
          )}
        >
          <PickerItem id="queue" onSelect={() => onPromptMode('queue')} style={{ paddingTop: 4, paddingBottom: 4 }}>
            <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <Label color={t.text}>{`Queue follow-up${!steering ? ' ✓' : ''}`}</Label>
              <Label color={t.textSecondary} size={12}>
                Send after the current work finishes · Enter
              </Label>
            </div>
          </PickerItem>
          <PickerItem id="steer" onSelect={() => onPromptMode('steer')} style={{ paddingTop: 4, paddingBottom: 4 }}>
            <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <Label color={t.text}>{`Steer now${steering ? ' ✓' : ''}`}</Label>
              <Label color={t.textSecondary} size={12}>
                Guide the current turn immediately · ⌘+Enter
              </Label>
            </div>
          </PickerItem>
        </PickerMenu>
      )}
    </div>
  )
}

/** Image tiles and file cards above the editor (`Composer.tsx:1143-1171`). */
function Attachments({ items, uploading, onRemove }: { items: Attachment[]; uploading: number; onRemove: (a: Attachment) => void }) {
  const t = useTheme()
  const elevated = t.v('--color-background-elevated-secondary')
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 6, marginLeft: -6, marginRight: -6, marginTop: -4, marginBottom: 8 }}>
      {items.map((a) => (
        // `t-pop` on each tile (`Composer.tsx:1147`); removal is instant there too.
        <Pop key={a.id}>
          {a.media_type.startsWith('image/') ? (
            <div
              testId={`attachment-${a.label}`}
              style={{ position: 'relative', width: 64, height: 64, flexShrink: 0, borderRadius: 12, borderWidth: 1, borderColor: t.borderLight, backgroundColor: elevated, overflow: 'hidden' }}
            >
              <img src={a.path} objectFit="cover" style={{ width: 62, height: 62, borderRadius: 11 }} />
              <div style={{ position: 'absolute', left: 4, bottom: 4, paddingLeft: 4, paddingRight: 4, borderRadius: 6, backgroundColor: 'rgba(0, 0, 0, 0.55)' }}>
                <Label color="#ffffff" size={10} lineHeight={16} weight={500}>{`@${a.label}`}</Label>
              </div>
              <RemoveButton testId={`remove-attachment-${a.label}`} onClick={() => onRemove(a)} />
            </div>
          ) : (
            <div
              testId={`attachment-${a.label}`}
              style={{
                position: 'relative',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                height: 56,
                width: 240,
                paddingTop: 8,
                paddingBottom: 8,
                paddingLeft: 8,
                paddingRight: 32,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: t.borderLight,
                backgroundColor: t.variant === 'dark' ? t.composer : '#ffffff',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 40, height: 40, flexShrink: 0, borderRadius: 8, backgroundColor: elevated }}>
                <Icon name="file" size={16} color={t.textSecondary} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 2, minWidth: 0, flexGrow: 1 }}>
                <Label color={t.text} size={13} weight={500} lineHeight={16} truncate>
                  {a.name}
                </Label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <Label color={t.textSecondary} size={11} weight={500} lineHeight={14}>{`@${a.label}`}</Label>
                  <Label color={t.textSecondary} size={11} weight={500} lineHeight={14}>
                    {(a.name.split('.').pop() ?? '').toUpperCase()}
                  </Label>
                </div>
              </div>
              <RemoveButton testId={`remove-attachment-${a.label}`} onClick={() => onRemove(a)} />
            </div>
          )}
        </Pop>
      ))}
      {uploading > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingLeft: 4, paddingRight: 4, height: 24 }}>
          <MatrixLoader />
          <Label color={t.textSecondary} size={12}>
            Uploading…
          </Label>
        </div>
      )}
    </div>
  )
}

/** A 20px ink disc with a 12px ×, top-right. */
function RemoveButton({ onClick, testId }: { onClick: () => void; testId?: string }) {
  const t = useTheme()
  return (
    <div
      testId={testId}
      onClick={onClick}
      style={{
        position: 'absolute',
        top: 4,
        right: 4,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 20,
        height: 20,
        borderRadius: 10,
        cursor: 'pointer',
        backgroundColor: ink(t, 0.8),
        hover: { backgroundColor: t.text },
      }}
    >
      <Icon source={G.x} size={12} color={t.surface} />
    </div>
  )
}

/** Queued follow-ups stacked above the card (`QueuedPanel` in `views/Thread.tsx`). */
function QueuedPanel({ threadId, items }: { threadId: string; items: { id: string; message: UserMessage }[] }) {
  const t = useTheme()
  const dark = t.variant === 'dark'
  const border = dark ? 'rgba(252, 252, 252, 0.036)' : 'rgba(13, 13, 13, 0.076)'
  return (
    <div
      testId="queued-panel"
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '93.33%',
        marginBottom: -1,
        borderTopLeftRadius: COMPOSER_RADIUS,
        borderTopRightRadius: COMPOSER_RADIUS,
        borderTopWidth: 1,
        borderLeftWidth: 1,
        borderRightWidth: 1,
        borderColor: border,
        backgroundColor: dark ? t.composer : 'rgba(255, 255, 255, 0.37)',
        paddingBottom: 4,
      }}
    >
      <div style={{ display: 'flex', paddingLeft: 12, paddingRight: 12, paddingTop: 8 }}>
        <Label color={t.textSecondary} size={12}>{`Queued · ${items.length}`}</Label>
      </div>
      {/* `t-row-enter` on each row as it arrives (`QueuedRow` in `views/Thread.tsx`); rows and the panel leave instantly. */}
      {items.map((item, i) => (
        <Rise key={item.id} kind="row">
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              paddingLeft: 10,
              paddingRight: 6,
              paddingTop: 4,
              paddingBottom: 4,
              ...(i > 0 ? { borderTopWidth: 1, borderColor: border } : {}),
            }}
          >
            <Icon source={G.clock} size={14} color={t.textSecondary} />
            <Label color={ink(t, 0.85)} size={12} weight={500} truncate style={{ flexGrow: 1 }}>
              {promptText(item.message) || 'Queued follow-up'}
            </Label>
            <div
              onClick={() => void removeQueued(threadId, item.id).catch(() => {})}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, borderRadius: 6, cursor: 'pointer', hover: { backgroundColor: t.buttonSecondaryHover } }}
            >
              <Icon source={G.x} size={12} color={t.textTertiary} />
            </div>
          </div>
        </Rise>
      ))}
    </div>
  )
}

