// One shared clock for every live elapsed time (group row, member rows, strip, bar, hover
// card). A clock is a text node registered once; this module writes `textContent` on whole
// second boundaries. There is no React state, context or store write per tick.
//
// It pauses when nothing is registered, when the document or window is not on screen, and
// skips nodes the loop-visibility observer reports as offscreen. On resume it writes once
// immediately. Pure and dependency-free so it can be tested with fake nodes and timers.

import { formatElapsed } from "../../../../packages/kybern-client/src/subagents.ts"

export interface ClockNode {
  textContent: string | null
  hasAttribute?(name: string): boolean
}

export interface ClockEnvironment {
  now(): number
  setTimer(run: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  /** False while the window is hidden, minimized or occluded. */
  running(): boolean
}

interface Entry {
  node: ClockNode
  startedAt: number
  text: string
}

export interface ElapsedClock {
  /** Show `startedAt` → now on `node` and keep it current. Returns the unregister function. */
  track(node: ClockNode, startedAt: number): () => void
  /** Write a settled duration once; nothing keeps ticking. */
  settle(node: ClockNode, startedAt: number, endedAt: number): void
  /** The environment changed (window shown again): write every clock now and resume. */
  wake(): void
  readonly size: number
}

export function createElapsedClock(env: ClockEnvironment): ElapsedClock {
  const entries = new Set<Entry>()
  let timer: unknown = null

  const write = (entry: Entry, now: number) => {
    const text = formatElapsed(now - entry.startedAt)
    if (text === entry.text) return
    entry.text = text
    entry.node.textContent = text
  }

  const schedule = () => {
    if (timer !== null || entries.size === 0 || !env.running()) return
    // Aim just past the next whole second so the digit never lags a frame.
    const delay = 1000 - (env.now() % 1000) + 8
    timer = env.setTimer(() => {
      timer = null
      if (!env.running()) return
      const now = env.now()
      for (const entry of entries) if (!entry.node.hasAttribute?.("data-loop-paused")) write(entry, now)
      schedule()
    }, delay)
  }

  return {
    track(node, startedAt) {
      const entry: Entry = { node, startedAt, text: node.textContent ?? "" }
      entries.add(entry)
      write(entry, env.now())
      schedule()
      return () => {
        entries.delete(entry)
        if (entries.size === 0 && timer !== null) {
          env.clearTimer(timer)
          timer = null
        }
      }
    },
    settle(node, startedAt, endedAt) {
      const text = formatElapsed(endedAt - startedAt)
      if (node.textContent !== text) node.textContent = text
    },
    wake() {
      if (!env.running()) return
      const now = env.now()
      for (const entry of entries) write(entry, now)
      schedule()
    },
    get size() {
      return entries.size
    },
  }
}
