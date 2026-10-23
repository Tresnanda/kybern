// The typing guard: a card that would replace the composer (a question, a password prompt, a pick of a file) waits while the
// reader is typing, and opens once the composer has been idle for `IDLE_MS`. Until then `RequestStack` shows a quiet hint
// above the composer, and Esc or a click opens the card at once. Nothing typed is lost either way: the composer keeps its
// draft per thread (`composer/drafts.ts`) and takes it back when the card closes.
//
// The state is module-level so the three readers agree: the stack that draws the hint, the page that keeps or hides the
// composer (`useBlockingRequest`) and the countdown of a question with a deadline, which does not run while the card is unseen
// (`RequestStack` pauses it for as long as the card is held). Keyed by approval id. A decision is made once, when the card is
// first seen: a card that was not held never becomes held later, and one that was released stays released.
import { useSyncExternalStore } from 'react'
import type { ApprovalRequest } from '../../../../packages/kybern-client/src/types.ts'
import { isUserInput } from '../../../../packages/kybern-client/src/userInput.ts'
import { isElementPick, pickRequestInput } from '../../../../packages/kybern-client/src/pickRequest.ts'
import { secretRequestInput } from '../../../../packages/kybern-client/src/secretRequest.ts'
import { briefProposalInput, settingsProposalInput } from '../../../../packages/kybern-client/src/coordinatorCards.ts'
import { loginRequestInput, promptRequestInput } from '../../../../packages/kybern-client/src/requestCards.ts'
import { agentName } from './model.ts'
import { someoneIsTyping } from './ui.ts'

/** The composer has been still this long: the card opens. */
export const IDLE_MS = 1500

export interface GuardEnv {
  now: () => number
  /** Whether a composer has text in it (nothing to protect otherwise). */
  typing: () => boolean
  setTimer: (run: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
}

export interface Guard {
  /** A key went into a composer. */
  keystroke: () => void
  /** Decides on first sight, then answers: true while the card must wait. */
  arrive: (id: string) => boolean
  isHeld: (id: string) => boolean
  /** Opens the card now (Esc, a click, a thread switch). */
  release: (id: string) => void
  /** The card is gone (answered, or its thread closed). */
  forget: (id: string) => void
  /** Milliseconds until the idle window ends, for a held card; 0 otherwise. */
  remaining: (id: string) => number
  subscribe: (listener: () => void) => () => void
}

export function createGuard(env: GuardEnv): Guard {
  let lastKey = -Infinity
  const held = new Set<string>()
  const seen = new Set<string>()
  const timers = new Map<string, unknown>()
  const listeners = new Set<() => void>()
  const emit = () => { for (const listener of [...listeners]) listener() }
  const remaining = (id: string) => held.has(id) ? Math.max(0, lastKey + IDLE_MS - env.now()) : 0

  const stop = (id: string) => {
    const handle = timers.get(id)
    if (handle !== undefined) env.clearTimer(handle)
    timers.delete(id)
  }
  const release = (id: string) => {
    stop(id)
    if (held.delete(id)) emit()
  }
  const schedule = (id: string) => {
    stop(id)
    // +1 ms: the window is over when `now - lastKey` reaches it, and a timer may fire a hair early.
    timers.set(id, env.setTimer(() => {
      timers.delete(id)
      if (!held.has(id)) return
      const left = remaining(id)
      if (left > 0) schedule(id)
      else release(id)
    }, remaining(id) + 1))
  }

  return {
    keystroke() {
      lastKey = env.now()
      // Every held card waits for the new end of the window.
      for (const id of held) schedule(id)
    },
    arrive(id) {
      if (seen.has(id)) return held.has(id)
      seen.add(id)
      if (env.typing() && env.now() - lastKey < IDLE_MS) {
        // No notification: this runs while a reader renders, and every reader of this card decides through here first.
        held.add(id)
        schedule(id)
      }
      return held.has(id)
    },
    isHeld: (id) => held.has(id),
    release,
    forget(id) {
      release(id)
      seen.delete(id)
    },
    remaining,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

const guard = createGuard({
  now: () => Date.now(),
  typing: someoneIsTyping,
  setTimer: (run, ms) => setTimeout(run, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
})

/** The composer received a key. Called on every edit that comes from the keyboard. */
export const noteKeystroke = guard.keystroke
export const isCardHeld = guard.isHeld
export const releaseCard = guard.release
export const forgetCardHold = guard.forget

/** Whether the card (a request that would take the composer) must wait for the reader to pause. `null` for a request that does
 *  not take the composer. Safe to call from several components: the first call decides. */
export function useCardHold(id: string | null): boolean {
  return useSyncExternalStore(guard.subscribe, () => (id ? guard.arrive(id) : false))
}

/** A password prompt or a secret: these open on the pause or a click, never on Esc, so a stray key cannot reach their field. */
export const isSensitiveCard = (approval: ApprovalRequest): boolean => !!secretRequestInput(approval) || !!promptRequestInput(approval)

/** What the hint above the composer says is waiting: "Claude has a question". */
export function holdTitle(approval: ApprovalRequest, provider: string | undefined): string {
  const agent = agentName(provider)
  const cap = agent === 'the agent' ? 'The agent' : agent
  if (promptRequestInput(approval)) return `${cap} needs a password`
  if (secretRequestInput(approval)) return `${cap} needs a key`
  if (loginRequestInput(approval)) return `${cap} needs a sign-in code`
  const pick = pickRequestInput(approval)
  if (pick && !isElementPick(pick.kind)) return `${cap} needs you to choose something`
  if (briefProposalInput(approval) || settingsProposalInput(approval)) return `${cap} has a proposal`
  if (isUserInput(approval)) return `${cap} has a question`
  return `${cap} needs your input`
}

/** Esc in the composer: opens the held card now, unless it is a sensitive one. True when it did (the key is consumed). */
export function openHeldCard(approval: ApprovalRequest): boolean {
  if (!guard.isHeld(approval.id) || isSensitiveCard(approval)) return false
  guard.release(approval.id)
  return true
}
