// Optimistic sends. Enter shows the message in the transcript on the same frame, before `threads.send`/`threads.steer`
// answers: the composer adds a pending user block with the message id it then sends (`message_id`, or the steer `id`).
// The daemon's `turn_started`/`message_steered` block carries that id, so the transcript swaps the pending block for the
// real one by id, under the same row (`turnKey` in `Transcript.tsx` prefers the user id): no duplicate, jump or replayed
// entrance. A rejected send stays as a failed bubble with Retry and Edit (`transcript/Turn.tsx`).
import { useSyncExternalStore } from 'react'
import type { Block } from '../../../../packages/kybern-client/src/transcript.ts'
import type { ThreadId, TurnId, UserMessage } from '../../../../packages/kybern-client/src/types.ts'
import { onEnvironmentChange } from '../shell/environment.ts'

export interface PendingSend {
  id: string
  threadId: ThreadId
  message: UserMessage
  at: string
  delivery: 'send' | 'steer'
  /** `accepted`: the daemon answered; the block shows until its own event arrives. */
  state: 'sending' | 'accepted' | 'failed'
  error?: string
}

/** How long an accepted send waits for its event before it is dropped (the thread was closed meanwhile; reopening loads it). */
const ACCEPTED_TTL_MS = 60_000
const NONE: readonly PendingSend[] = []
const byThread = new Map<ThreadId, readonly PendingSend[]>()
const listeners = new Set<() => void>()
const emit = () => { for (const listener of [...listeners]) listener() }
export const subscribePending = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
export const pendingFor = (threadId: ThreadId | null | undefined): readonly PendingSend[] => (threadId && byThread.get(threadId)) || NONE

function write(threadId: ThreadId, next: readonly PendingSend[]) {
  if (next.length) byThread.set(threadId, next)
  else byThread.delete(threadId)
  emit()
}
export function addPending(send: PendingSend) {
  write(send.threadId, [...pendingFor(send.threadId).filter(p => p.id !== send.id), send])
}
export function updatePending(threadId: ThreadId, id: string, patch: Partial<Pick<PendingSend, 'state' | 'error'>>) {
  const list = pendingFor(threadId)
  if (!list.some(p => p.id === id)) return
  write(threadId, list.map(p => (p.id === id ? { ...p, ...patch } : p)))
  if (patch.state === 'accepted') setTimeout(() => { if (pendingFor(threadId).some(p => p.id === id && p.state === 'accepted')) removePending(threadId, id) }, ACCEPTED_TTL_MS)
}
export function removePending(threadId: ThreadId, id: string) {
  const list = pendingFor(threadId)
  if (list.some(p => p.id === id)) write(threadId, list.filter(p => p.id !== id))
}
onEnvironmentChange(() => { if (byThread.size) { byThread.clear(); emit() } })

/** Pending sends whose real block is in `blocks` now: the caller removes them (outside render). */
export function settledPending(blocks: readonly Block[], pending: readonly PendingSend[]): string[] {
  if (!pending.length) return []
  const ids = new Set(pending.map(p => p.id)), settled: string[] = []
  // Real user blocks arrive at the tail; a short scan from the end finds them.
  for (let i = blocks.length - 1, seen = 0; i >= 0 && seen < 400 && settled.length < ids.size; i--, seen++) {
    const block = blocks[i]!
    if (block.kind === 'user' && ids.has(block.id)) settled.push(block.id)
  }
  return settled
}

const merged = new WeakMap<readonly Block[], { pending: readonly PendingSend[]; blocks: Block[] }>()
/** `blocks` plus a user block per pending send not yet in them, each its own turn (`pending:<id>`). The same inputs
 *  return the same array, so grouping and row caches keep their identity. */
export function withPending(blocks: Block[], pending: readonly PendingSend[]): Block[] {
  if (!pending.length) return blocks
  const cached = merged.get(blocks)
  if (cached?.pending === pending) return cached.blocks
  const settled = new Set(settledPending(blocks, pending))
  // A steer joins the running turn, as its `message_steered` block will; a send opens its own turn.
  const live = blocks.at(-1)?.turnId
  const extra = pending.filter(p => !settled.has(p.id)).map(p => pendingBlock(p, p.delivery === 'steer' && live ? live : `pending:${p.id}`))
  const result = extra.length ? [...blocks, ...extra] : blocks
  merged.set(blocks, { pending, blocks: result })
  return result
}

const blocksFor = new Map<string, Block>()
function pendingBlock(send: PendingSend, turnId: TurnId): Block {
  // One object per send, so a pending row keeps its identity while other sends change.
  const key = `${send.id}:${send.at}:${turnId}`
  let block = blocksFor.get(key)
  if (!block) {
    block = { kind: 'user', id: send.id, turnId, at: send.at, seq: Number.MAX_SAFE_INTEGER, message: send.message }
    blocksFor.set(key, block)
    if (blocksFor.size > 64) blocksFor.delete(blocksFor.keys().next().value!)
  }
  return block
}

export function usePendingSends(threadId: ThreadId | null | undefined) {
  return useSyncExternalStore(subscribePending, () => pendingFor(threadId))
}
export function usePendingSend(threadId: ThreadId | null | undefined, id: string | undefined): PendingSend | null {
  return useSyncExternalStore(subscribePending, () => (id ? pendingFor(threadId).find(p => p.id === id) ?? null : null))
}
