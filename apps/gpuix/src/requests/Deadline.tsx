// A question with a deadline (`kybern_ask_user` with a default and a wait): the hint line's countdown, and the pause while the
// reader interacts. The daemon owns the clock (`RequestProgress` `asking` / `paused` / `held`); the card asks it to pause on
// hover, focus, an arrow key or typing, and to resume 5 s after the last interaction. Calm to the end: no red, no pulse.
// Never on approvals. Spec: `cards/spec.md` §5.
import { useEffect, useRef } from 'react'
import type { QuestionDeadline } from '../../../../packages/kybern-client/src/types.ts'
import { deadlineState, formatCountdown } from '../../../../packages/kybern-client/src/requestCards.ts'
import { useLoaderSecond } from '../MatrixLoader.tsx'
import { Swap } from '../motion/kit.tsx'
import { ringValue } from '../motion/success.ts'
import { Icon } from '../icons.tsx'
import { Label } from '../ui.tsx'
import { useCardTokens } from './Card.tsx'
import { RG } from './glyphs.ts'
import { actOnRequest, useRequestProgress } from './progress.ts'

/** The reader stopped interacting this long ago: the countdown resumes. */
export const RESUME_AFTER_MS = 5000

const TRACK = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5.6" stroke="#000" stroke-width="1.6"/></svg>'

/**
 * Pause and resume, as the daemon's `requests.act` `pause` / `resume`. `touch()` on every interaction (a key, a click, typing);
 * `hover(true/false)` while the pointer is over the card. Resumes 5 s after the last one; never resets the clock.
 */
export function usePauseController(approvalId: string, enabled: boolean) {
  const paused = useRef(false)
  const hovering = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clear = () => { if (timer.current) clearTimeout(timer.current); timer.current = null }
  const send = (action: 'pause' | 'resume') => { void actOnRequest(approvalId, action).catch(() => { /* an older daemon: the countdown keeps running */ }) }
  const resume = () => { clear(); if (paused.current) { paused.current = false; send('resume') } }
  const schedule = () => { clear(); if (!hovering.current) timer.current = setTimeout(resume, RESUME_AFTER_MS) }
  const touch = () => {
    if (!enabled) return
    if (!paused.current) { paused.current = true; send('pause') }
    schedule()
  }
  const hover = (on: boolean) => { if (!enabled) return; hovering.current = on; if (on) touch(); else schedule() }
  const latest = useRef(resume)
  latest.current = resume
  // A card that leaves while paused (another thread opened) must not hold the deadline forever.
  useEffect(() => () => latest.current(), [])
  return { touch, hover }
}

/** "Going with “In a 32 px row” in 9:41 unless you pick", or "Paused while you choose. 9:41 left". Re-renders once a second. */
export function DeadlineHint({ approvalId, deadline, chosen }: { approvalId: string; deadline: QuestionDeadline; /** The default's label, or null when several questions fall back. */ chosen: string | null }) {
  const k = useCardTokens()
  const progress = useRequestProgress(approvalId)
  const second = useLoaderSecond(progress?.phase !== 'held')
  void second
  const state = deadlineState(deadline, progress, Date.now())
  if (state.phase === 'held') return <Label color={k.t.textTertiary} size={12} lineHeight={16} truncate>Kybern waits for your answer.</Label>
  const time = formatCountdown(state.remainingMs)
  const quiet = (text: string) => <Label color={k.t.textSecondary} size={12} lineHeight={16} style={{ flexShrink: 0 }}>{text}</Label>
  const strong = (text: string) => <Label color={k.t.text} size={12} lineHeight={16} weight={500} style={{ flexShrink: 0, fontVariantNumeric: 'tabular-nums' } as never}>{text}</Label>
  const ring = ringValue({ size: 14, radius: 5.6, strokeWidth: 1.6, fraction: state.fraction })
  return (
    <div testId="deadline-hint" role="timer" aria-label={state.phase === 'paused' ? `Paused. ${time} left` : `Going with ${chosen ?? 'the default'} in ${time} unless you pick`} style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0, flexShrink: 1, overflow: 'hidden' }}>
      <Swap kind="icon" active={state.phase} style={{ width: 14, height: 14, flexShrink: 0 }}>
        {state.phase === 'paused'
          ? <Icon source={RG.pause} size={13} color={k.t.textTertiary} />
          : (
            <div style={{ position: 'relative', display: 'flex', width: 14, height: 14 }}>
              <svg source={TRACK} style={{ position: 'absolute', left: 0, top: 0, width: 14, height: 14, color: k.c.ink(0.12) }} />
              <svg testId="deadline-ring" source={ring.source} {...(ring.paintAnimation ? { paintAnimation: ring.paintAnimation } : {})} style={{ position: 'absolute', left: 0, top: 0, width: 14, height: 14, color: k.t.textSecondary }} />
            </div>
          )}
      </Swap>
      <div style={{ display: 'flex', alignItems: 'center', minWidth: 0, flexShrink: 1, overflow: 'hidden' }}>
        {state.phase === 'paused'
          ? <>{quiet('Paused while you choose.\u00a0')}{strong(time)}{quiet('\u00a0left')}</>
          : <>{quiet('Going with\u00a0')}{strong(chosen ? `“${chosen}”` : 'the defaults')}{quiet('\u00a0in\u00a0')}{strong(time)}{quiet('\u00a0unless you pick')}</>}
      </div>
    </div>
  )
}
