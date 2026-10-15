import { onEnvironmentChange, onEnvironmentLeaving } from '../shell/environment.ts'
import { load, save } from '../shell/persist.ts'
// Composer data and actions: the agent catalog, settings and accounts, the open
// thread's next-message target, queued follow-ups, and the home screen's draft
// choices. Every RPC here is the one the desktop uses (`state/rpc.ts`,
// `views/Thread.tsx`, `views/Draft.tsx`), so behaviour stays in step.
//
// The desktop keeps draft choices, favorites and recents in localStorage; here
// they live for the session only.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { useSyncExternalStore } from 'react'
import { getClient, getState, refreshLists, selectThread } from '../state.ts'
import { httpBase } from '../../../../packages/kybern-client/src/address.ts'
import type {
  AccountSummary,
  GitBranchesResult,
  PermissionMode,
  ProjectId,
  ProviderInstance,
  ProviderKind,
  ProviderStatus,
  QueuedMessage,
  Settings,
  ThreadId,
  ThreadTargetState,
  UserMessage,
} from '../../../../packages/kybern-client/src/types.ts'
import type { FavoriteModel } from '../../../../packages/kybern-client/src/models.ts'

export interface DraftChoices {
  /** `null` follows `settings.default_permission_mode`. */
  mode: PermissionMode | null
  provider: (ProviderInstance & { pinAccount?: boolean }) | null
  models: Partial<Record<ProviderKind, { model?: string; effort?: string }>>
  /** `undefined` is the most recently active project; `null` is Free chat. */
  projectId: ProjectId | null | undefined
  worktree: boolean | null
  baseBranch: string | null
}

export interface ComposerData {
  providers: ProviderStatus[]
  providersLoading: boolean
  settings: Settings | null
  accounts: AccountSummary[]
  target: { threadId: ThreadId; state: ThreadTargetState } | null
  /** Per-account model catalog of the open thread's target (`providers.accounts.catalog`). */
  catalog: { key: string; status: ProviderStatus } | null
  catalogLoading: string | null
  queued: Record<ThreadId, QueuedMessage[]>
  branches: { projectId: ProjectId; result: GitBranchesResult } | null
  draft: DraftChoices
  favorites: FavoriteModel[]
  recents: Record<string, string[]>
}

const initialData: ComposerData = {
  providers: [],
  providersLoading: false,
  settings: null,
  accounts: [],
  target: null,
  catalog: null,
  catalogLoading: null,
  queued: {},
  branches: null,
  draft: { mode: null, provider: null, models: {}, projectId: undefined, worktree: null, baseBranch: null },
  favorites: [],
  recents: {},
}
let data: ComposerData = { ...initialData, ...load<Partial<Pick<ComposerData, 'draft' | 'favorites' | 'recents'>>>('kybern.composer.choices', {}) }
const listeners = new Set<() => void>()

export function patch(next: Partial<ComposerData> | ((d: ComposerData) => Partial<ComposerData>)) {
  const previous = data
  data = { ...data, ...(typeof next === 'function' ? next(data) : next) }
  if (data.draft !== previous.draft || data.favorites !== previous.favorites || data.recents !== previous.recents) save('kybern.composer.choices', { draft: data.draft, favorites: data.favorites, recents: data.recents })
  for (const l of listeners) l()
}

export function patchDraft(next: Partial<DraftChoices>) {
  patch((d) => ({ draft: { ...d.draft, ...next } }))
}

export const getData = () => data

export function useComposer<T>(select: (d: ComposerData) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => select(data),
  )
}

function rpc() {
  const client = getClient()
  if (!client) throw new Error('Start kybernd, then reopen this window')
  return client
}

/** `errorText` from `state/rpc.ts`: the daemon's message, or the thrown text. */
export function errorText(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e && typeof (e as { message: unknown }).message === 'string')
    return (e as { message: string }).message
  return String(e)
}

// ---- catalog, settings, accounts ----

let loadedFor: unknown = null

/** Load what the composer reads, once per connection. */
export function ensureLoaded() {
  const client = getClient()
  if (!client || client === loadedFor || getState().status !== 'open') return
  loadedFor = client
  client.onNotification('settings.changed', (params) => {
    if (getClient() !== client) return
    const settings = (params as { settings?: Settings } | null)?.settings
    if (settings && client === getClient()) patch({ settings })
    void loadProviders(false).catch(() => {})
  })
  // Like the desktop's provider cache: paint the last catalog at once, since
  // `providers.list` probes every agent CLI and can take seconds.
  const cached = readProviderCache(client.endpoint.url)
  if (cached && !data.providers.length) patch({ providers: cached })
  void loadProviders(false).catch(() => {})
  void client.call('settings.get', {}).then((settings) => { if (getClient() === client) patch({ settings }) }).catch(() => {})
  void client
    .call('providers.accounts.list', {})
    .then((r) => { if (getClient() === client) patch({ accounts: r.accounts }) })
    .catch(() => {})
}

let providerLoad: Promise<ProviderStatus[]> | null = null
export function loadProviders(force: boolean, projectId?: ProjectId): Promise<ProviderStatus[]> {
  if (providerLoad && !force) return providerLoad
  patch({ providersLoading: true })
  const client = rpc()
  const request = client
    .call('providers.list', { ...(projectId ? { project_id: projectId } : {}), ...(force ? { force_refresh: true } : {}) })
    .then((r) => {
      if (getClient() !== client) return r.providers
      patch({ providers: r.providers })
      if (!projectId) writeProviderCache(client.endpoint.url, r.providers)
      return r.providers
    })
    .finally(() => {
      if (getClient() !== client) return
      if (providerLoad === request) providerLoad = null
      patch({ providersLoading: false })
    })
  providerLoad = request
  return request
}

const CACHE_DIR = process.env.KYBERN_CLIENT_CONFIG_DIR ? path.join(process.env.KYBERN_CLIENT_CONFIG_DIR, 'cache') : path.join(homedir(), 'Library', 'Caches', 'kybern-gpuix')
const cacheFile = (url: string) => path.join(CACHE_DIR, `providers-${url.replace(/[^a-z0-9]+/gi, '_')}.json`)

function readProviderCache(url: string): ProviderStatus[] | null {
  try {
    return JSON.parse(readFileSync(cacheFile(url), 'utf8')) as ProviderStatus[]
  } catch {
    return null
  }
}

function writeProviderCache(url: string, providers: ProviderStatus[]) {
  try {
    mkdirSync(CACHE_DIR, { recursive: true })
    writeFileSync(cacheFile(url), JSON.stringify(providers))
  } catch {
    // A cache miss only costs the first paint.
  }
}

// ---- the open thread's next-message target ----

let targetSeq = 0
export async function loadTarget(threadId: ThreadId) {
  const seq = ++targetSeq
  try {
    const state = await rpc().call('threads.target.get', { thread_id: threadId })
    if (seq === targetSeq) patch({ target: { threadId, state } })
  } catch {
    // An old daemon has no target API; the thread's own fields stand in.
  }
}

let catalogSeq = 0
/** `refreshAccountCatalog` in `views/Thread.tsx`. */
export async function loadCatalog(threadId: ThreadId, provider: ProviderInstance, projectId: ProjectId, force: boolean) {
  const key = `${threadId}:${provider.kind}:${provider.instance}`
  const seq = ++catalogSeq
  patch({ catalogLoading: key })
  try {
    const status = await rpc().call('providers.accounts.catalog', { provider, project_id: projectId, force_refresh: force })
    if (seq === catalogSeq) patch({ catalog: { key, status } })
    return status
  } finally {
    if (seq === catalogSeq) patch({ catalogLoading: null })
  }
}

/** `changePermission`: `threads.update`, then the target again. */
export async function setThreadMode(threadId: ThreadId, mode: PermissionMode) {
  const client = rpc()
  await client.call('threads.update', { thread_id: threadId, permission_mode: mode })
  if (getClient() !== client) return
  await refreshLists()
  if (getClient() === client) await loadTarget(threadId)
}

/** `chooseTarget` with the thread's target and a new model/effort. */
export async function setThreadModel(threadId: ThreadId, model: string | undefined, effort: string | undefined) {
  const current = data.target?.threadId === threadId ? data.target.state : null
  const thread = getState().threads.find((t) => t.id === threadId) ?? getState().open.thread
  const provider = current?.target.provider ?? thread?.provider
  if (!provider) return
  const client = rpc()
  const state = await client.call('threads.target.set', {
    thread_id: threadId,
    target: { provider, model, effort },
    inherit_account: !current?.account_override,
  })
  if (getClient() === client) patch({ target: { threadId, state } })
}

// ---- sending ----

export async function loadQueue(threadId: ThreadId) {
  const client = rpc()
  try {
    const r = await client.call('queue.list', { thread_id: threadId })
    if (getClient() !== client) return
    patch((d) => ({ queued: { ...d.queued, [threadId]: r.messages.filter((m) => m.thread_id === threadId) } }))
  } catch {
    // Older daemons have no queue.
  }
}

export async function sendToThread(threadId: ThreadId, message: UserMessage, delivery: 'send' | 'queue' | 'steer') {
  if (delivery === 'send') {
    await rpc().call('threads.send', { thread_id: threadId, message })
    return
  }
  if (delivery === 'steer') {
    await rpc().call('threads.steer', { thread_id: threadId, id: crypto.randomUUID(), message })
    return
  }
  const client = rpc()
  await client.call('queue.add', { thread_id: threadId, id: crypto.randomUUID(), message })
  if (getClient() === client) await loadQueue(threadId)
}

export async function removeQueued(threadId: ThreadId, id: string) {
  const client = rpc()
  await client.call('queue.remove', { thread_id: threadId, id })
  if (getClient() === client) await loadQueue(threadId)
}

export async function interruptThread(threadId: ThreadId) {
  await rpc().call('threads.interrupt', { thread_id: threadId })
}

/** `createThread` from the home screen, then open it. */
export async function createThread(opts: {
  projectId: ProjectId | null
  provider: ProviderInstance
  pinAccount: boolean
  permissionMode: PermissionMode
  model?: string
  effort?: string
  useWorktree: boolean
  baseBranch?: string
  message: UserMessage
}) {
  const client = rpc()
  const t = await client.call('threads.create', {
    ...(opts.projectId ? { project_id: opts.projectId } : {}),
    provider: opts.provider,
    pin_account: opts.pinAccount,
    permission_mode: opts.permissionMode,
    model: opts.model,
    effort: opts.effort,
    use_worktree: opts.useWorktree,
    base_branch: opts.baseBranch,
    message: opts.message,
  })
  if (getClient() !== client) return t.id
  await refreshLists()
  if (getClient() === client) void selectThread(t.id)
  return t.id
}

export async function loadBranches(projectId: ProjectId) {
  const client = rpc()
  try {
    const result = await client.call('git.branches', { project_id: projectId })
    if (getClient() !== client) return
    patch({ branches: { projectId, result } })
  } catch {
    if (getClient() !== client) return
    patch({ branches: { projectId, result: { current: null, branches: [] } } })
  }
}

// ---- attachments ----

function assetsEndpoint(): { base: string; token: string } {
  const { url, token } = rpc().endpoint
  return { base: httpBase(url), token }
}

export interface UploadedAsset {
  id: string
  name: string
  media_type: string
  size: number
}

/** `uploadFile`: POST the bytes to the daemon's `/assets`. */
export async function uploadPath(path: string): Promise<UploadedAsset> {
  const file = Bun.file(path)
  const name = path.split('/').pop() ?? 'file'
  const { base, token } = assetsEndpoint()
  const response = await fetch(`${base}/assets`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      origin: 'tauri://localhost',
      'content-type': file.type || 'application/octet-stream',
      'x-kybern-filename': name,
    },
    body: await file.arrayBuffer(),
  })
  if (!response.ok) {
    const detail = (await response.text()).trim()
    throw new Error(detail || `Upload failed (${response.status})`)
  }
  return (await response.json()) as UploadedAsset
}

onEnvironmentLeaving(() => save('kybern.composer.choices', { draft: data.draft, favorites: data.favorites, recents: data.recents }))
onEnvironmentChange(() => { loadedFor = null; providerLoad = null; targetSeq++; catalogSeq++; patch({ ...initialData, ...load<Partial<Pick<ComposerData, 'draft' | 'favorites' | 'recents'>>>('kybern.composer.choices', {}) }) })
