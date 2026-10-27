// The first scene (SPEC §2): the mark assembles from two halves, the headline arrives word by word, then the subline and the
// actions. Plays once per install; any key except Return and Tab skips it to its end state, Return presses the button.
import { useGpuixRequired, useWindowSize, type PublicInstance } from '@gpuix/react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '../kit/Button.tsx'
import { Kbd } from '../kit/Kbd.tsx'
import { EASE } from '../motion/tokens.ts'
import { addWindowKeyHandler } from '../nav/keys.ts'
import { showEnvironmentDialog } from '../environments/Dialogs.tsx'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { observeElementBounds } from '../native/layout.ts'
import { isWindowVisible } from '../native/visibility.ts'
import { Label, LOGO_SVG, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { Cta } from './Cta.tsx'
import { flow, next, useFlow } from './flow.ts'
import { balance, bez, In, Words } from './motion.tsx'
import { markRects } from './markFlight.ts'

/** The headline, sized as `clamp(40, 6.4vw, 76)`. */
export const headlineSize = (width: number) => Math.round(Math.min(76, Math.max(40, width * 0.064)))
const HEADLINE = 'Run every coding agent in one place.'
const SUBLINE = 'Claude Code, Codex, OpenCode, Cursor and more, side by side in your repos.'
const CAL = 'Cal Sans'
const MARK_W = 72, MARK_H = 45

/** The Kybern mark in two clipped halves that slide together (SPEC §2.1). `intro` plays the assembly; otherwise it is whole. */
export function AssemblingMark({ intro, fast, color }: { intro: boolean; fast: boolean; color: string }) {
  const t = useTheme()
  const renderer = useGpuixRequired()
  const box = useRef<PublicInstance | null>(null)
  useEffect(() => {
    const node = box.current
    if (!node) return
    return observeElementBounds(renderer, { id: node.id }, (event) => { if (event.rect) markRects.hero = event.rect })
  }, [renderer])
  const play = intro && PATCHED_NATIVE && !fast && !REDUCED_MOTION
  const half = (side: -1 | 1) => (
    <div
      key={side}
      paintTransform={intro && PATCHED_NATIVE
        ? play
          ? { initial: { opacity: 0, translateX: side * 34, scale: 0.9, blur: 8 }, animate: { opacity: 1, translateX: 0, scale: 1, blur: 0 }, transition: { duration: 1, delay: 0.08, ease: bez([0.34, 1.12, 0.64, 1]) } }
          : { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: 0.15, ease: bez(EASE.out) } }
        : undefined}
      style={{ position: 'absolute', top: 0, left: side < 0 ? 0 : MARK_W / 2 - 0.3, width: MARK_W / 2 + 0.3, height: MARK_H, overflow: 'hidden', pointerEvents: 'none' }}
    >
      <svg source={LOGO_SVG} style={{ position: 'absolute', top: 0, left: side < 0 ? 0 : -(MARK_W / 2 - 0.3), width: MARK_W, height: MARK_H, color, pointerEvents: 'none' }} />
    </div>
  )
  const ring = (delay: number) => (
    <div
      key={delay}
      paintTransform={{ initial: { opacity: 0, scale: 0.5 }, keyframes: [{ offset: 0.12, opacity: 0.9 }], animate: { opacity: 0, scale: 1.6 }, transition: { duration: 1.1, delay, ease: bez(EASE.out) } }}
      style={{ position: 'absolute', left: (MARK_W - 140) / 2, top: (MARK_H - 140) / 2, width: 140, height: 140, borderRadius: 70, borderWidth: 1, borderColor: t.cardEdge, pointerEvents: 'none' }}
    />
  )
  return (
    <div ref={box} testId="onboarding-mark" style={{ position: 'relative', width: MARK_W, height: MARK_H, flexShrink: 0 }}>
      {play && [ring(0.65), ring(0.95)]}
      <div
        paintTransform={play ? { initial: { scale: 1 }, keyframes: [{ offset: 0.5, scale: 1 }, { offset: 0.56, scale: 0.94 }], animate: { scale: 1 }, transition: { duration: 1.2, ease: bez(EASE.out) } } : undefined}
        style={{ position: 'absolute', left: 0, top: 0, width: MARK_W, height: MARK_H }}
      >
        {half(-1)}
        {half(1)}
      </div>
    </div>
  )
}

/** The hero's breathing mark: 1 ↔ 1.035 over 5.2 s, one retarget per half cycle, paused while the window is hidden. */
function Breath({ children, run }: { children: React.ReactNode; run: boolean }) {
  const [up, setUp] = useState(false)
  const gen = useRef(1)
  const active = run && PATCHED_NATIVE && !REDUCED_MOTION
  useEffect(() => { if (active) setUp(true) }, [active])
  if (!active) return <div>{children}</div>
  return (
    <div
      paintTransform={{ initial: false, animate: { scale: up ? 1.035 : 1 }, transition: { duration: 2.6, ease: bez([0.37, 0, 0.63, 1]) }, generation: gen.current, retain: true }}
      onMotionComplete={(e) => { if (e.motionGeneration === gen.current && isWindowVisible()) { gen.current++; setUp((v) => !v) } }}
    >
      {children}
    </div>
  )
}

export function Hero() {
  const t = useTheme()
  const size = useWindowSize({ intervalMs: 300 })
  const width = size?.width ?? 1440
  const height = size?.height ?? 900
  const introPlayed = flow.get().introPlayed
  const [skipped, setSkipped] = useState(introPlayed)
  const [settled, setSettled] = useState(introPlayed)
  const [pressed, setPressed] = useState(false)
  const current = useFlow((s) => s.scene === 'hero')
  const fast = skipped
  const go = useRef(() => {})
  go.current = () => { setPressed(true); setTimeout(() => { setPressed(false); flow.set({ introPlayed: true }); next() }, 140) }

  useEffect(() => {
    if (!current) return
    return addWindowKeyHandler((event) => {
      const key = event.key
      if (key === 'enter') { go.current(); return true }
      if (key === 'tab') return false
      if (event.modifiers?.cmd || event.modifiers?.ctrl) return false
      if (!skipped) { setSkipped(true); flow.set({ introPlayed: true }); return false }
      return false
    })
  }, [current, skipped])
  useEffect(() => {
    if (fast) { setSettled(true); return }
    const timer = setTimeout(() => { setSettled(true); flow.set({ introPlayed: true }) }, 2200)
    return () => clearTimeout(timer)
  }, [fast])

  const headSize = headlineSize(width)
  const lineHeight = Math.round(headSize * 1.04)
  const maxChars = Math.max(10, Math.floor((Math.min(width - 96, headSize * 14)) / (headSize * 0.47)))
  const lines = balance(HEADLINE, maxChars)
  const subWidth = Math.min(500, width - 64)
  return (
    <div style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', paddingBottom: Math.round(height * 0.04), paddingLeft: 32, paddingRight: 32 }}>
      <div key={fast ? 'fast' : 'full'} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <Breath run={settled && current}><AssemblingMark intro fast={fast} color={t.text} /></Breath>
        <div style={{ height: 36 }} />
        <Words lines={lines} size={headSize} lineHeight={lineHeight} color={t.text} font={CAL} fast={fast} />
        <div style={{ height: 20 }} />
        <In delay={0.74} fast={fast} y={10} style={{ width: subWidth, alignItems: 'center' }}>
          {balance(SUBLINE, Math.max(24, Math.floor(subWidth / 8.2))).map((line, i) => (
            <Label key={i} color={t.textSecondary} size={17} lineHeight={25.5} style={{ textAlign: 'center', width: '100%' }}>{line.join(' ')}</Label>
          ))}
        </In>
        <div style={{ height: 32 }} />
        <In delay={0.81} fast={fast} y={10} style={{ alignItems: 'center', gap: 10 }}>
          <Cta testId="onboarding-start" pressed={pressed} onClick={() => go.current()}>Get started</Cta>
          <Button testId="onboarding-connect" variant="ghost" onClick={() => showEnvironmentDialog({ kind: 'add' })}>Connect to another machine</Button>
        </In>
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 28, display: 'flex', justifyContent: 'center' }}>
        <In key={fast ? 'fast-hint' : 'hint'} delay={1.23} fast={fast} y={6} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Label color={t.textTertiary} size={12} lineHeight={16}>Press</Label>
          <Kbd keys={[process.platform === 'darwin' ? 'Return' : 'Enter']} />
          <Label color={t.textTertiary} size={12} lineHeight={16}>to start</Label>
        </In>
      </div>
    </div>
  )
}
