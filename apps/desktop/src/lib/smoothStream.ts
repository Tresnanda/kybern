// Smooth streaming reveal, provider-agnostic. Harnesses flush assistant text at
// wildly different granularities — Claude streams tokens, Codex/OpenCode send
// larger bursts, some send a whole message at once — and even one harness streams
// in bumps: a chunk, a pause, a chunk. Revealing text the instant it lands makes
// it lurch; revealing it as fast as possible empties the buffer and then stalls
// until the next chunk ("stream, stop, stream, stop").
//
// So this is a jitter buffer, like a media player. We reveal at a velocity that
// drains the current backlog over a short window rather than instantly, which
// keeps a little text in reserve. At steady arrival the reveal rate self-tunes to
// the incoming rate and holds ~LIVE_BUFFER_MS of text buffered, so any gap
// shorter than that window is covered and playback never visibly stops.

/** Drain the backlog over roughly this window while tokens are still arriving. */
export const LIVE_BUFFER_MS = 450
/** Once the full message has arrived, drain what's left promptly. */
export const COMPLETE_BUFFER_MS = 110
/** Velocity eases toward its target over ~this long, so a burst doesn't surge. */
export const VELOCITY_TAU_MS = 130
/** Floor/ceiling on reveal speed (characters per second). */
export const MIN_CPS = 24
export const MAX_CPS = 2400
/** Ignore frames longer than this (e.g. a backgrounded tab) so we don't jump. */
export const MAX_FRAME_MS = 100

/** `shown` is the revealed length (fractional); `vel` is characters per ms. */
export interface SmoothState {
  shown: number
  vel: number
}

/**
 * Advance the reveal one frame. Targets a velocity that drains the backlog over a
 * buffer window (kept, not raced to zero), eased so bursts don't surge, clamped to
 * a readable speed range, and never overshooting the received text.
 */
export function smoothAdvance(state: SmoothState, target: number, elapsedMs: number, complete: boolean): SmoothState {
  const remaining = target - state.shown
  if (remaining <= 0) return { shown: target, vel: 0 }
  const dt = Math.max(0, Math.min(elapsedMs, MAX_FRAME_MS))
  const bufferMs = complete ? COMPLETE_BUFFER_MS : LIVE_BUFFER_MS
  const desiredCps = Math.min(MAX_CPS, Math.max(MIN_CPS, (remaining / bufferMs) * 1000))
  const desired = desiredCps / 1000 // characters per ms
  const ease = dt > 0 ? 1 - Math.exp(-dt / VELOCITY_TAU_MS) : 0
  const vel = state.vel + (desired - state.vel) * ease
  const shown = state.shown + vel * dt
  return shown >= target ? { shown: target, vel: 0 } : { shown, vel }
}
