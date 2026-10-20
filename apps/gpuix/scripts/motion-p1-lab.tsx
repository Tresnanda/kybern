// P1 motion lab: the sidebar status glyph, the row title swap and the hover-actions/glyph crossfade of a thread row, in fixed spots and
// driven by keys from motion-p1-strips.ts (the real sidebar needs a live agent turn to change a thread's status).
//   g StatusGlyph steps (working → unread → failed → none → pending → pinned → working) · t title rename · h row hover on/off
import '../src/native/local-build.ts'
import { render } from '@gpuix/react'
import { Profiler, useState } from 'react'
import { ThemeProvider, useTheme, Label, ProviderMark } from '../src/ui.tsx'
import { N } from '../src/nav/glyphs.ts'
import { Icon } from '../src/icons.tsx'
import { StatusGlyph, IconButton, accent, resting } from '../src/sidebar/rows.tsx'
import { FadeBack, MarqueeLabel, Reveal, TitleSwap } from '../src/sidebar/motion.tsx'
import { muted } from '../src/nav/overlay.tsx'

let commits = 0
const STEPS = [
  { status: 'running' as const }, { status: 'idle' as const, unread: true }, { status: 'failed' as const }, { status: 'idle' as const },
  { status: 'awaiting-approval' as const }, { status: 'idle' as const, pinned: true }, { status: 'running' as const },
]
const TITLES = ['Fix the sidebar jitter', 'Sidebar jitter fixed — verify on resize']
const at = (x: number, y: number, w: number, h: number) => ({ position: 'absolute', left: x, top: y, width: w, height: h, display: 'flex' }) as const

function Lab() {
  const t = useTheme()
  const [step, setStep] = useState(0), [title, setTitle] = useState(0), [hover, setHover] = useState(false)
  const s = STEPS[step % STEPS.length]!
  const action = (k: string) => {
    if (k === 'g') setStep(n => n + 1)
    if (k === 't') setTitle(n => n + 1)
    if (k === 'h') setHover(v => !v)
  }
  const text = TITLES[title % 2]!
  return (
    <div testId="app-ready" onKeyDown={e => action(e.key ?? '')} style={{ position: 'relative', width: '100%', height: '100%', backgroundColor: t.sidebar }}>
      {/* The glyph alone, 15x15 */}
      <div testId="glyph" style={{ ...at(24, 24, 40, 40), alignItems: 'center', justifyContent: 'center' }}>
        <StatusGlyph status={s.status} unread={s.unread} pinned={s.pinned} />
      </div>
      {/* A row: provider mark, swapping title, the resting glyph and the hover actions on the right edge */}
      <div testId="row" style={{ ...at(24, 90, 256, 28), alignItems: 'center', gap: 8, paddingLeft: 8, borderRadius: 8, ...(hover ? { backgroundColor: accent(t) } : {}) }}>
        <ProviderMark kind="claude-code" size={12} />
        <TitleSwap text={text}><MarqueeLabel hover={false} text={text} color={resting(t)} /></TitleSwap>
        <div style={{ position: 'absolute', top: 0, bottom: 0, right: 6, display: 'flex', alignItems: 'center', pointerEvents: 'none' }}>
          {!hover && <FadeBack play style={{ width: 15 }}><StatusGlyph status="idle" unread /></FadeBack>}
        </div>
        <div style={{ position: 'absolute', top: 0, bottom: 0, right: 6, display: 'flex', alignItems: 'center' }}>
          <Reveal show={hover}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <IconButton icon={N.pin} glyph={15} color={muted(t, 0.34)} label="Pin" />
              <IconButton icon={N.archive} glyph={15} color={muted(t, 0.42)} label="Archive" />
            </div>
          </Reveal>
        </div>
      </div>
      <div style={at(24, 140, 256, 20)}><Label color={t.textSecondary} size={11}>g status · t title · h hover</Label></div>
      <div style={{ ...at(24, 170, 24, 24) }}><Icon source={N.clock} size={12} color={t.text} /></div>
    </div>
  )
}
render(<ThemeProvider><Profiler id="lab" onRender={() => { console.error(`[lab-commit] ${++commits}`) }}><Lab /></Profiler></ThemeProvider>, { title: 'motion-p1', width: 360, height: 240, focus: false })
