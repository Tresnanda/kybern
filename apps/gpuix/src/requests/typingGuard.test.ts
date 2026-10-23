import { describe, expect, test } from 'bun:test'
import { PROMPT_REQUEST_TOOL, SECRET_REQUEST_TOOL, type ApprovalRequest } from '../../../../packages/kybern-client/src/types.ts'
import { createGuard, holdTitle, IDLE_MS, isSensitiveCard, type GuardEnv } from './typingGuard.ts'

/** A clock the test moves by hand, with timers that fire when it passes them. */
function fakeEnv(typing = true) {
  let time = 100_000
  let next = 1
  const timers = new Map<number, { at: number; run: () => void }>()
  const env: GuardEnv & { advance: (ms: number) => void; typing: () => boolean; setTyping: (on: boolean) => void } = {
    now: () => time,
    typing: () => typing,
    setTyping: (on) => { typing = on },
    setTimer: (run, ms) => { const id = next++; timers.set(id, { at: time + ms, run }); return id },
    clearTimer: (handle) => { timers.delete(handle as number) },
    advance(ms) {
      const end = time + ms
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        time = due[1].at
        due[1].run()
      }
      time = end
    },
  }
  return env
}

describe('typing guard', () => {
  test('a card that arrives while the reader is typing waits for the idle window', () => {
    const env = fakeEnv()
    const guard = createGuard(env)
    guard.keystroke()
    env.advance(300)
    expect(guard.arrive('a')).toBe(true)
    env.advance(IDLE_MS - 300 - 10)
    expect(guard.isHeld('a')).toBe(true)
    env.advance(20)
    expect(guard.isHeld('a')).toBe(false)
  })

  test('every keystroke starts the window over', () => {
    const env = fakeEnv()
    const guard = createGuard(env)
    guard.keystroke()
    guard.arrive('a')
    for (let i = 0; i < 5; i++) { env.advance(IDLE_MS - 200); expect(guard.isHeld('a')).toBe(true); guard.keystroke() }
    env.advance(IDLE_MS + 5)
    expect(guard.isHeld('a')).toBe(false)
  })

  test('a card is not held when the reader paused already, or the composer is empty', () => {
    const env = fakeEnv()
    const guard = createGuard(env)
    guard.keystroke()
    env.advance(IDLE_MS + 1)
    expect(guard.arrive('late')).toBe(false)
    guard.keystroke()
    env.setTyping(false)
    expect(guard.arrive('empty')).toBe(false)
  })

  test('the decision is made once: typing later never takes a shown card back', () => {
    const env = fakeEnv()
    const guard = createGuard(env)
    expect(guard.arrive('a')).toBe(false)
    guard.keystroke()
    expect(guard.arrive('a')).toBe(false)
    guard.keystroke()
    guard.arrive('b')
    env.advance(IDLE_MS + 5)
    guard.keystroke()
    expect(guard.arrive('b')).toBe(false)
  })

  test('release opens a held card at once and notifies readers', () => {
    const env = fakeEnv()
    const guard = createGuard(env)
    let calls = 0
    guard.subscribe(() => { calls++ })
    guard.keystroke()
    guard.arrive('a')
    guard.release('a')
    expect(guard.isHeld('a')).toBe(false)
    expect(calls).toBe(1)
    env.advance(IDLE_MS * 2)
    expect(calls).toBe(1)
  })

  test('the idle window ends with a notification, once', () => {
    const env = fakeEnv()
    const guard = createGuard(env)
    let calls = 0
    guard.subscribe(() => { calls++ })
    guard.keystroke()
    guard.arrive('a')
    env.advance(IDLE_MS + 5)
    expect(calls).toBe(1)
    expect(guard.remaining('a')).toBe(0)
  })

  test('forget clears the card so a new one with the same id decides again', () => {
    const env = fakeEnv()
    const guard = createGuard(env)
    guard.keystroke()
    guard.arrive('a')
    guard.forget('a')
    expect(guard.isHeld('a')).toBe(false)
    expect(guard.arrive('a')).toBe(true)
  })

  test('several held cards each open on the same pause', () => {
    const env = fakeEnv()
    const guard = createGuard(env)
    guard.keystroke()
    guard.arrive('a')
    guard.arrive('b')
    env.advance(IDLE_MS + 5)
    expect([guard.isHeld('a'), guard.isHeld('b')]).toEqual([false, false])
  })
})

const card = (tool_name: string, input: unknown): ApprovalRequest => ({ id: 'x', thread_id: 't', tool_name, input } as unknown as ApprovalRequest)

describe('hint copy', () => {
  test('names the agent and what it needs', () => {
    expect(holdTitle(card('AskUserQuestion', { questions: [] }), 'claude-code')).toBe('Claude has a question')
    expect(holdTitle(card('AskUserQuestion', { questions: [] }), undefined)).toBe('The agent has a question')
  })

  test('passwords and secrets are the cards that open on a pause or a click only', () => {
    const password = card(PROMPT_REQUEST_TOOL, { prompt: 'Password:', purpose: 'sudo' })
    const secret = card(SECRET_REQUEST_TOOL, { env_key: 'API_KEY', label: 'API key' })
    expect(isSensitiveCard(password)).toBe(true)
    expect(isSensitiveCard(secret)).toBe(true)
    expect(isSensitiveCard(card('AskUserQuestion', { questions: [] }))).toBe(false)
    expect(holdTitle(password, 'claude-code')).toBe('Claude needs a password')
    expect(holdTitle(secret, 'codex')).toBe('Codex needs a key')
  })
})
