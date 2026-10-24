import type { GroupChoice } from '../groups/tray.ts'
import {readAccounts} from '../requests/accounts.ts'
import { onEnvironmentChange, onEnvironmentLeaving } from '../shell/environment.ts'
import { load, save } from '../shell/persist.ts'
import { addPending, pendingFor, updatePending, type PendingSend } from './pending.ts'
import { newChats } from './newChats.ts'
import type { NewChatCreate } from '../../../../packages/kybern-client/src/newChat.ts'
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
import { useRef, useSyncExternalStore } from 'react'
import { getClient, getState, refreshLists, selectPaneThread, getFocusedPaneId, getPane, getPaneState, setPane, usePaneAccess, useApp } from '../state.ts'
import { httpBase } from '../../../../packages/kybern-client/src/address.ts'
import type { MentionPart } from '../../../../packages/kybern-client/src/userInput.ts'
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
  Thread,
  ThreadId,
  ThreadTargetState,
  UserMessage,
  ContentPart,
} from '../../../../packages/kybern-client/src/types.ts'
import type { DraftReferences } from './Completion.tsx'
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
  /** Group projects: the members and per-member branches of the new chat (`groups/tray.ts`), for one project. */
  group?: GroupChoice | null
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
  draft: { mode: null, provider: null, models: {}, projectId: undefined, worktree: null, baseBranch: null, group: null },
  favorites: [],
  recents: {},
}
let data: ComposerData = { ...initialData, ...load<Partial<Pick<ComposerData, 'draft' | 'favorites' | 'recents'>>>('kybern.composer.choices', {}) }
const targets = new Map<string, NonNullable<ComposerData['target']>>()
const catalogs = new Map<string, NonNullable<ComposerData['catalog']>>()
const catalogLoads = new Map<string, string>()
const paneDrafts = new Map<string, DraftChoices>()
const listeners = new Set<() => void>()
function scopedData(paneId: string, threadId: string | null): ComposerData {
  if (!paneDrafts.has(paneId)) paneDrafts.set(paneId, data.draft)
  return { ...data, draft: paneDrafts.get(paneId) ?? data.draft,
    target: threadId ? targets.get(threadId) ?? (data.target?.threadId === threadId ? data.target : null) : null,
    catalog: threadId ? catalogs.get(threadId) ?? null : null,
    catalogLoading: threadId ? catalogLoads.get(threadId) ?? null : null }
}

export function patch(next: Partial<ComposerData> | ((d: ComposerData) => Partial<ComposerData>)) {
  const previous = data
  data = { ...data, ...(typeof next === 'function' ? next(data) : next) }
  if (data.target) { targets.set(data.target.threadId, data.target); if (targets.size > 100) targets.delete(targets.keys().next().value!) }
  if (data.draft !== previous.draft || data.favorites !== previous.favorites || data.recents !== previous.recents) save('kybern.composer.choices', { draft: data.draft, favorites: data.favorites, recents: data.recents })
  for (const l of listeners) l()
}

export function patchDraft(next: Partial<DraftChoices>, paneId = getFocusedPaneId()) {
  const draft = { ...(paneDrafts.get(paneId) ?? data.draft), ...next }
  paneDrafts.set(paneId, draft)
  if ('projectId' in next) {
    const pane = getPane(paneId)
    if (pane) setPane(paneId, { draft: { ...pane.draft, projectId: next.projectId ?? undefined }, generation: pane.generation + 1 })
  }
  if (paneDrafts.size > 100) paneDrafts.delete(paneDrafts.keys().next().value!)
  // Keep the last choices as the defaults for future panes and legacy callers.
  patch({ draft })
}

export const getData = (paneId = getFocusedPaneId()) => scopedData(paneId, getPaneState(paneId).selectedId)

export function useComposer<T>(select: (d: ComposerData) => T): T {
  const pane = usePaneAccess()
  const threadId = useApp(s => s.selectedId)
  const frozen = useRef(scopedData(pane.id, threadId))
  if (!pane.frozen) frozen.current = scopedData(pane.id, threadId)
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => select(pane.frozen ? frozen.current : scopedData(pane.id, threadId)),
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
  void readAccounts(client)
    .then((r) => { if (getClient() === client) patch({ accounts: r.accounts }) })
    .catch(() => {})
}

/** Read the account list again (an account was added, changed or removed elsewhere, e.g. Settings). */
export function refreshComposerAccounts(accounts?: AccountSummary[]) {
  const client = getClient()
  if (!client) return Promise.resolve()
  if (accounts) { patch({ accounts }); return Promise.resolve() }
  return readAccounts(client).then((r) => { if (getClient() === client) patch({ accounts: r.accounts }) }).catch(() => {})
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

const targetSeq = new Map<string, number>()
export async function loadTarget(threadId: ThreadId) {
  // A new chat the daemon has not made yet has no target; its composer loads it once the thread exists.
  if (newChats.uncreated(threadId)) return
  const client = rpc()
  const seq = (targetSeq.get(threadId) ?? 0) + 1
  targetSeq.set(threadId, seq)
  try {
    const state = await client.call('threads.target.get', { thread_id: threadId })
    if (getClient() === client && seq === targetSeq.get(threadId)) patch({ target: { threadId, state } })
  } catch {
    // An old daemon has no target API; the thread's own fields stand in.
  }
}

const catalogSeq = new Map<string, number>()
/** `refreshAccountCatalog` in `views/Thread.tsx`. */
export async function loadCatalog(threadId: ThreadId, provider: ProviderInstance, projectId: ProjectId, force: boolean) {
  const key = `${threadId}:${provider.kind}:${provider.instance}`
  const client = rpc()
  const seq = (catalogSeq.get(threadId) ?? 0) + 1
  catalogSeq.set(threadId, seq)
  catalogLoads.set(threadId, key)
  patch({ catalogLoading: key })
  try {
    const status = await client.call('providers.accounts.catalog', { provider, project_id: projectId, force_refresh: force })
    if (getClient() === client && seq === catalogSeq.get(threadId)) { catalogs.set(threadId, { key, status }); if (catalogs.size > 100) catalogs.delete(catalogs.keys().next().value!); patch({ catalog: { key, status } }) }
    return status
  } finally {
    if (getClient() === client && seq === catalogSeq.get(threadId)) { catalogLoads.delete(threadId); patch({ catalogLoading: null }) }
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

/** Optimistic follow-ups whose `queue.add` has not answered yet. */
const queueing = new Set<string>()

export async function loadQueue(threadId: ThreadId) {
  const client = rpc()
  try {
    const r = await client.call('queue.list', { thread_id: threadId })
    if (getClient() !== client) return
    // Follow-ups still on their way to `queue.add` keep their place: a reload must not blink them out.
    patch((d) => {
      const listed = r.messages.filter((m) => m.thread_id === threadId)
      const local = (d.queued[threadId] ?? []).filter((m) => queueing.has(m.id) && !listed.some((l) => l.id === m.id))
      return { queued: { ...d.queued, [threadId]: [...listed, ...local] } }
    })
  } catch {
    // Older daemons have no queue.
  }
}

/** Optimistic: a send or steer shows as a pending user block on this frame and this returns before the daemon answers;
 * a rejection stays on that block as "Not sent" with Retry (`pending.ts`). A queued follow-up joins the queue list at
 * once and rejects (the composer gets the text back) when `queue.add` fails. */
export async function sendToThread(threadId: ThreadId, message: UserMessage, delivery: 'send' | 'queue' | 'steer') {
  if (delivery === 'queue') {
    const client = rpc(), item: QueuedMessage = { id: crypto.randomUUID(), thread_id: threadId, message }
    queueing.add(item.id)
    patch((d) => ({ queued: { ...d.queued, [threadId]: [...(d.queued[threadId] ?? []), item] } }))
    try {
      await inflight.get(threadId)
      await client.call('queue.add', item)
    } catch (e) {
      patch((d) => ({ queued: { ...d.queued, [threadId]: (d.queued[threadId] ?? []).filter((m) => m.id !== item.id) } }))
      throw e
    } finally { queueing.delete(item.id) }
    if (getClient() === client) await loadQueue(threadId)
    return
  }
  const send: PendingSend = { id: crypto.randomUUID(), threadId, message, at: new Date().toISOString(), delivery, state: 'sending' }
  addPending(send)
  const before = inflight.get(threadId)
  if (delivery === 'steer') { void (before ?? Promise.resolve()).then(() => deliverPending(send)); return }
  track(threadId, deliverPending(send))
}

/** A thread's send the daemon has not answered yet. A follow-up (queued or steered) waits for it, so it cannot reach the
 *  daemon first and overtake it: a worktree thread's send can take seconds, while `queue.add` on a thread that is not
 *  running yet starts its turn at once. Never rejects (`deliverPending` catches). */
const inflight = new Map<ThreadId, Promise<void>>()
function track(threadId: ThreadId, done: Promise<void>) {
  inflight.set(threadId, done)
  void done.then(() => { if (inflight.get(threadId) === done) inflight.delete(threadId) })
}

async function deliverPending(send: PendingSend) {
  try {
    if (send.delivery === 'send' && newChats.uncreated(send.threadId)) {
      // The daemon has no row for this new chat yet: its create runs again with the same thread id (a Retry, or an
      // edited first message with its own id). The daemon answers a repeat from the first call.
      const chat = newChats.get(send.threadId)!
      const done = await newChats.retry(send.threadId, chat.messageId === send.id ? undefined : { message: send.message, messageId: send.id })
      if (done?.state === 'failed') throw new Error(done.error)
    } else if (send.delivery === 'send') await rpc().call('threads.send', { thread_id: send.threadId, message: send.message, message_id: send.id })
    else await rpc().call('threads.steer', { thread_id: send.threadId, id: send.id, message: send.message })
    updatePending(send.threadId, send.id, { state: 'accepted' })
  } catch (e) {
    updatePending(send.threadId, send.id, { state: 'failed', error: errorText(e) })
  }
}

/** Retry a failed send with its own id: a daemon that did accept it answers with the same turn (`turn_started_receipt`). A
 * steer whose turn has ended goes as a normal send. */
export function retryPending(threadId: ThreadId, id: string) {
  const send = pendingFor(threadId).find((p) => p.id === id && p.state === 'failed')
  if (!send) return
  const thread = getState().threads.find((t) => t.id === threadId) ?? getState().open.thread
  const live = thread?.status === 'running' || thread?.status === 'awaiting-approval'
  const next: PendingSend = { ...send, delivery: send.delivery === 'steer' && !live ? 'send' : send.delivery, state: 'sending', error: undefined }
  addPending(next)
  if (next.delivery === 'send') track(threadId, deliverPending(next))
  else void deliverPending(next)
}

/** What the composer held when it sent: the text with its chips and the attachments with their previews. */
export interface SentDraft {
  text: string
  attachments: readonly { id: string; name: string; media_type: string; size: number; label: string; path: string }[]
  references: DraftReferences | null
}
// Keyed by the sent message's parts: a pending send keeps that array as its bubble's message, and it goes with it.
const sentDrafts = new WeakMap<readonly ContentPart[], SentDraft>()
export function rememberSentDraft(parts: readonly ContentPart[], draft: SentDraft) { sentDrafts.set(parts, draft) }

// A failed send's Edit puts the whole draft back into that thread's composer (`ComposerView` registers by draft key).
const restorers = new Map<string, (draft: SentDraft) => void>()
export function onComposerRestore(draftKey: string, restore: (draft: SentDraft) => void) {
  restorers.set(draftKey, restore)
  return () => { if (restorers.get(draftKey) === restore) restorers.delete(draftKey) }
}
/** `draftKey` without its pane prefix (`main:thread:<id>`): the focused pane's composer first, else any showing it. Restores
 *  the draft `parts` were sent from; without one (sent elsewhere), `fallbackText`. */
export function restoreToComposer(draftKey: string, parts: readonly ContentPart[], fallbackText: string): boolean {
  const keys = [...restorers.keys()].filter((key) => key === draftKey || key.endsWith(`:${draftKey}`))
  const focused = `${getFocusedPaneId()}:${draftKey}`
  const restore = restorers.get(keys.includes(focused) ? focused : keys[0] ?? '')
  if (!restore) return false
  restore(sentDrafts.get(parts) ?? { text: fallbackText, attachments: [], references: null })
  return true
}

// A chip made outside the composer (an element ⌥-clicked in the Preview) goes into that thread's composer at its caret.
const chipInserters = new Map<string, (part: MentionPart) => void>()
/** Chips made while no composer showed the thread (its Preview tab was in front): they land when its composer is back. */
const waitingChips = new Map<string, MentionPart[]>()
export function onComposerInsertChip(draftKey: string, insert: (part: MentionPart) => void) {
  chipInserters.set(draftKey, insert)
  // The registered key carries its pane prefix (`main:thread:<id>`); the waiting chips are keyed without it.
  const bare = draftKey.slice(draftKey.indexOf(':') + 1)
  const waiting = waitingChips.get(bare)
  if (waiting) { waitingChips.delete(bare); for (const part of waiting) setTimeout(() => insert(part), 0) }
  return () => { if (chipInserters.get(draftKey) === insert) chipInserters.delete(draftKey) }
}
/** Inserts `part` into the composer showing `draftKey` (without its pane prefix): the focused pane's first. False when none shows it. */
export function insertChipIntoComposer(draftKey: string, part: MentionPart): boolean {
  const keys = [...chipInserters.keys()].filter((key) => key === draftKey || key.endsWith(`:${draftKey}`))
  const focused = `${getFocusedPaneId()}:${draftKey}`
  const insert = chipInserters.get(keys.includes(focused) ? focused : keys[0] ?? '')
  if (!insert) {
    waitingChips.set(draftKey, [...(waitingChips.get(draftKey) ?? []).slice(-7), part])
    return false
  }
  insert(part)
  return true
}

export async function removeQueued(threadId: ThreadId, id: string) {
  const client = rpc()
  await client.call('queue.remove', { thread_id: threadId, id })
  if (getClient() === client) await loadQueue(threadId)
}

/** Agents whose running turn accepts steering (`views/Thread.tsx:388`). */
export const STEERABLE = ['claude-code', 'codex', 'pi', 'omp']

/** A queued follow-up sent into the running turn now. It leaves the queue first, so the turn's end cannot deliver it too;
 *  if the queue no longer has it (the turn just ended and sent it), nothing more is sent. A steer whose turn has ended by
 *  then goes as a normal send (`deliverPending`). */
export async function steerQueued(threadId: ThreadId, item: QueuedMessage) {
  await removeQueued(threadId, item.id)
  await sendToThread(threadId, item.message, 'steer')
}

export async function interruptThread(threadId: ThreadId) {
  await rpc().call('threads.interrupt', { thread_id: threadId })
}

/** A new chat from the home screen, optimistic (`composer/newChats.ts`): the thread gets its id here, its row and page show
 *  on this frame with the prompt as a pending bubble, and `create` makes it on the daemon behind them. A failure stays on the
 *  thread page as the bubble's "Not sent" with Retry and Edit; both reuse the thread id. Returns the thread id. */
export function launchNewChat(opts: {
  paneId?: string
  threadId: ThreadId
  thread: Thread
  message: UserMessage
  worktree: boolean
  /** Makes the thread with `thread_id` = `threadId` and delivers `message` with `message_id` = `messageId`. */
  create: NewChatCreate
}): ThreadId {
  const paneId = opts.paneId ?? getFocusedPaneId()
  const client = rpc()
  const send: PendingSend = { id: crypto.randomUUID(), threadId: opts.threadId, message: opts.message, at: new Date().toISOString(), delivery: 'send', state: 'sending' }
  addPending(send)
  const started = newChats.start({ threadId: opts.threadId, messageId: send.id, message: opts.message, worktree: opts.worktree, thread: opts.thread }, opts.create)
  track(opts.threadId, started.then((chat) => {
    if (chat.state === 'failed') updatePending(opts.threadId, send.id, { state: 'failed', error: chat.error })
    else if (chat.messageId === send.id) updatePending(opts.threadId, send.id, { state: 'accepted' })
    // The list catches up behind the page; nothing waits for it.
    if (getClient() === client) void refreshLists()
  }))
  void selectPaneThread(paneId, opts.threadId)
  return opts.threadId
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
  return uploadBytes(name, file.type || 'application/octet-stream', await file.arrayBuffer())
}

/** Clipboard images use the same upload contract as files, without a temporary file. */
export async function uploadBytes(name: string, mediaType: string, bytes: ArrayBuffer | Uint8Array): Promise<UploadedAsset> {
  const { base, token } = assetsEndpoint()
  const response = await fetch(`${base}/assets`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      origin: 'tauri://localhost',
      'content-type': mediaType,
      'x-kybern-filename': name,
    },
    body: bytes as BodyInit,
  })
  if (!response.ok) {
    const detail = (await response.text()).trim()
    throw new Error(detail || `Upload failed (${response.status})`)
  }
  return (await response.json()) as UploadedAsset
}

onEnvironmentLeaving(() => save('kybern.composer.choices', { draft: data.draft, favorites: data.favorites, recents: data.recents }))
onEnvironmentChange(() => { loadedFor = null; providerLoad = null; targetSeq.clear(); catalogSeq.clear(); targets.clear(); catalogs.clear(); catalogLoads.clear(); paneDrafts.clear(); patch({ ...initialData, ...load<Partial<Pick<ComposerData, 'draft' | 'favorites' | 'recents'>>>('kybern.composer.choices', {}) }) })
