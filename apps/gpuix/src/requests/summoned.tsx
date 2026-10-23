// Small parts the summoned cards share: the fade when rows give way to a status line, the ticking "14:12 left", and text with
// `code` spans.
import { useRef, type ReactNode } from 'react'
import { formatCountdown } from '../../../../packages/kybern-client/src/requestCards.ts'
import { useLoaderSecond } from '../MatrixLoader.tsx'
import { EASE } from '../motion/kit.tsx'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { FONT_MONO } from '../theme.ts'
import { Label, REDUCED_MOTION } from '../ui.tsx'
import { useCardTokens } from './Card.tsx'

const EASE_OUT = [...EASE.out] as [number, number, number, number]

/**
 * A card's body for one phase (asking, waiting, done). When the phase changes after the card arrived, the new body fades in over
 * 120 ms from 4 px low (Reduce Motion: the fade only); the card's height changes once, with no tween. Paint-only.
 */
export function PhaseIn({ phase, children }: { phase: string; children: ReactNode }) {
  const first = useRef(phase)
  const moved = useRef(false)
  if (phase !== first.current) moved.current = true
  const transform = moved.current && PATCHED_NATIVE
    ? REDUCED_MOTION
      ? { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: 0.12, ease: EASE_OUT } }
      : { initial: { opacity: 0, translateY: 4 }, animate: { opacity: 1, translateY: 0 }, transition: { duration: 0.12, ease: EASE_OUT } }
    : undefined
  return <div key={phase} paintTransform={transform} style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>{children}</div>
}

/** "14:12 left", once a second (information, so it keeps counting under Reduce Motion). Only this label re-renders. */
export function TimeLeft({ endsAt, suffix = ' left' }: { endsAt: string; suffix?: string }) {
  const k = useCardTokens()
  useLoaderSecond(true)
  const ends = Date.parse(endsAt)
  if (Number.isNaN(ends)) return null
  return <div testId="request-time-left" style={{ display: 'flex', flexShrink: 0 }}><Label color={k.t.textTertiary} size={12} lineHeight={16} style={{ fontVariantNumeric: 'tabular-nums' } as never}>{`${formatCountdown(ends - Date.now())}${suffix}`}</Label></div>
}

/** Splits "`gh` for this Mac" into runs, marking the backticked ones as code. */
export function codeRuns(text: string): { text: string; code: boolean }[] {
  return text.split(/`([^`]+)`/).map((run, i) => ({ text: run, code: i % 2 === 1 })).filter((run) => run.text)
}

/** Running text with inline code chips; wraps like a paragraph. */
export function CodeText({ text, size = 12, color, lineHeight = 17 }: { text: string; size?: number; color?: string; lineHeight?: number }) {
  const k = useCardTokens()
  const ink = color ?? k.t.textSecondary
  const runs = codeRuns(text)
  if (runs.every((run) => !run.code)) return <text style={{ color: ink, fontSize: size, lineHeight, fontFamily: '.SystemUIFont', minWidth: 0 }}>{text}</text>
  return (
    <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', minWidth: 0 }}>
      {runs.flatMap((run, i) => run.code
        ? [<div key={i} style={{ display: 'flex', alignItems: 'center', height: lineHeight, paddingLeft: 4, paddingRight: 4, borderRadius: 5, marginLeft: 1, marginRight: 1, backgroundColor: k.chipBg }}>
            <text style={{ color: k.t.text, fontFamily: FONT_MONO, fontSize: size - 0.5, lineHeight: lineHeight - 2, whiteSpace: 'nowrap' }}>{run.text}</text>
          </div>]
        // One run per word with its trailing space, so wrapping happens between words at the font's own spacing.
        : run.text.split(/(?<=\s)/).map((piece, j) => <text key={`${i}-${j}`} style={{ color: ink, fontSize: size, lineHeight, fontFamily: '.SystemUIFont', whiteSpace: 'nowrap' }}>{piece.replace(/\s+$/, '\u00a0')}</text>))}
    </div>
  )
}
