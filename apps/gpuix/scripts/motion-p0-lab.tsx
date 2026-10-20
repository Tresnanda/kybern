// P0 motion lab: every foundation helper in a fixed spot, driven by keys and real mouse events from motion-p0-strips.ts.
// r Rise kinds · s Swap text/icon · c copy→check · p Presence · o PopupLayer leaving · k chevrons · m meters · a arc · h reveal · n count pop
import '../src/native/local-build.ts'
import { render } from '@gpuix/react'
import { Profiler, useState } from 'react'
import { ThemeProvider, useTheme, Label, ink } from '../src/ui.tsx'
import { Rise, Swap, SwapOnChange, ENTER, revealTransform } from '../src/motion/kit.tsx'
import { Presence, EXIT } from '../src/motion/Presence.tsx'
import { Chevron } from '../src/motion/Chevron.tsx'
import { MeterFill } from '../src/motion/Meter.tsx'
import { arcDraw, ringArc } from '../src/motion/success.ts'
import { hoverPressTransform, pressRowStyle } from '../src/motion/press.ts'
import { popAnimation, useCountPop } from '../src/kit/Pop.tsx'
import { PickerItem, PickerMenu, PopupLayer, popoverStyle } from '../src/composer/Menu.tsx'
import { N } from '../src/nav/glyphs.ts'
import { Icon } from '../src/icons.tsx'
import { SuccessCheck } from '../src/motion/SuccessCheck.tsx'

let commits = 0
const KINDS = Object.keys(ENTER) as (keyof typeof ENTER)[]
const at = (x: number, y: number, w: number, h: number) => ({ position: 'absolute', left: x, top: y, width: w, height: h, display: 'flex' }) as const

function Lab() {
  const t = useTheme()
  const [rise, setRise] = useState(0), [swap, setSwap] = useState(0), [copy, setCopy] = useState(false), [show, setShow] = useState(true)
  const [popup, setPopup] = useState<'closed' | 'open' | 'leaving'>('closed'), [open, setOpen] = useState(false)
  const [still, setStill] = useState(false), [kbd, setKbd] = useState(true)
  const [turned, setTurned] = useState(false), [meter, setMeter] = useState(0), [arc, setArc] = useState(0), [hovered, setHovered] = useState(true), [hoverBtn, setHoverBtn] = useState(false), [count, setCount] = useState(3)
  const action = (k: string) => {
    if (k === 'r') setRise(n => n + 1)
    if (k === 's') setSwap(n => n + 1)
    if (k === 'c') setCopy(v => !v)
    if (k === 'p') setShow(v => !v)
    if (k === 'o') setPopup(v => (v === 'open' ? 'leaving' : 'open'))
    if (k === 'q') setStill(v => !v)
    if (k === 'w') setKbd(v => !v)
    if (k === 'k') setTurned(v => !v)
    if (k === 'm') setMeter(v => (v === 0 ? 1 : v === 1 ? 0.6 : 0.2))
    if (k === 'a') setArc(n => n + 1)
    if (k === 'h') setHovered(v => !v)
    if (k === 'n') setCount(v => v + 1)
  }
  const fill = t.buttonSecondaryHover, ring = ringArc({ size: 48, radius: 20, strokeWidth: 4, fraction: 0.62 })
  const countKey = useCountPop(count)
  return (
    <div testId="app-ready" onKeyDown={e => action(e.key ?? '')} style={{ position: 'relative', width: '100%', height: '100%', backgroundColor: t.v('--background') }}>
      {/* Rise kinds, one slot each so layout never moves */}
      <div testId="rise" style={at(16, 16, 900, 84)}>
        {KINDS.map(kind => (
          <div key={kind} style={{ display: 'flex', width: 108, height: 84, flexShrink: 0 }}>
            <Rise key={`${kind}-${rise}`} kind={kind} index={0} play={rise > 0} style={{ width: 100, height: 76 }}>
              <div style={{ display: 'flex', flexDirection: 'column', width: 100, height: 76, borderRadius: 10, backgroundColor: fill, borderWidth: 1, borderColor: t.border, alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                <Label color={t.text} size={12}>{kind}</Label>
                <div style={{ width: 40, height: 6, borderRadius: 3, backgroundColor: ink(t, 0.5) }} />
              </div>
            </Rise>
          </div>
        ))}
      </div>
      {/* Swaps */}
      <div testId="swap-text" style={at(16, 124, 150, 32)}><SwapOnChange active={swap % 2 ? 'sending' : 'send'} style={{ width: 150, height: 32, justifyContent: 'flex-start' }}><Label color={t.text} size={14}>{swap % 2 ? 'Sending…' : 'Send message'}</Label></SwapOnChange></div>
      <div testId="swap-icon" style={at(200, 124, 40, 32)}><SwapOnChange kind="icon" active={swap % 2 ? 'check' : 'copy'} style={{ width: 40, height: 32 }}>{swap % 2 ? <Icon source={N.check} size={20} color={t.green} /> : <Icon source={N.chevronRight} size={20} color={t.text} />}</SwapOnChange></div>
      <div testId="swap-copy" style={at(280, 124, 40, 32)}><Swap kind="icon" active={copy ? 'check' : 'copy'} still style={{ width: 40, height: 32 }}>{copy ? <SuccessCheck size={20} color={t.green} play={false} /> : <Icon source={N.chevronRight} size={20} color={t.text} />}</Swap></div>
      {/* Presence */}
      <div testId="presence" style={at(16, 180, 220, 130)}>
        <Presence show={show} exit={EXIT.dialog} enter={{ initial: { opacity: 0, scale: 0.98 }, animate: { opacity: 1, scale: 1 }, transition: { duration: 0.25 } }} style={{ width: 200 }}>
          <div style={{ display: 'flex', flexDirection: 'column', width: 200, height: 110, borderRadius: 14, backgroundColor: t.popover, borderWidth: 1, borderColor: t.border, padding: 12, gap: 8 }}>
            <Label color={t.text} size={14}>Presence card</Label>
            <div style={{ height: 8, borderRadius: 4, backgroundColor: ink(t, 0.3) }} /><div style={{ height: 8, width: 120, borderRadius: 4, backgroundColor: ink(t, 0.3) }} />
          </div>
        </Presence>
      </div>
      {/* PickerMenu (default materialize) */}
      <div testId="picker" style={{ ...at(300, 180, 240, 220), alignItems: 'flex-start' }}>
        <PickerMenu open={open} onOpenChange={setOpen} side="bottom" align="start" sideOffset={6} width={200}
          trigger={() => <div testId="picker-trigger" style={{ display: 'flex', alignItems: 'center', height: 28, paddingLeft: 10, paddingRight: 10, borderRadius: 10, backgroundColor: fill }}><Label color={t.text} size={13}>Model picker</Label></div>}>
          <PickerItem id="a" onSelect={() => {}}><Label color={t.text} size={13}>Opus 5.5</Label></PickerItem>
          <PickerItem id="b" onSelect={() => {}}><Label color={t.text} size={13}>Sonnet 5.5</Label></PickerItem>
          <PickerItem id="c" onSelect={() => {}}><Label color={t.text} size={13}>Haiku 5.5</Label></PickerItem>
        </PickerMenu>
      </div>
      {/* PopupLayer with leaving/onLeft */}
      <div testId="leaving" style={{ ...at(560, 180, 240, 160), alignItems: 'flex-start' }}>
        <div style={{ display: 'flex', position: 'relative' }}>
          <div style={{ display: 'flex', alignItems: 'center', height: 28, paddingLeft: 10, paddingRight: 10, borderRadius: 10, backgroundColor: fill }}><Label color={t.text} size={13}>Trigger (o)</Label></div>
          {popup !== 'closed' && (
            <PopupLayer side="bottom" align="end" sideOffset={6} leaving={popup === 'leaving'} onLeft={() => setPopup('closed')} style={{ ...popoverStyle(t), width: 180, padding: 12 }}>
              <Label color={t.text} size={13}>Leaving popup</Label>
            </PopupLayer>
          )}
        </div>
      </div>
      {/* Keyboard paths (V-kbd): a `still` popup and a zero-duration Presence exit show their end state in one frame */}
      <div testId="kbd" style={{ ...at(560, 260, 300, 90), alignItems: 'flex-start', gap: 16 }}>
        <div style={{ display: 'flex', position: 'relative' }}>
          <div style={{ display: 'flex', alignItems: 'center', height: 28, paddingLeft: 10, paddingRight: 10, borderRadius: 10, backgroundColor: fill }}><Label color={t.text} size={13}>Still (q)</Label></div>
          {still && <PopupLayer still side="bottom" align="start" sideOffset={6} style={{ ...popoverStyle(t), width: 120, padding: 12 }}><Label color={t.text} size={13}>Opened by key</Label></PopupLayer>}
        </div>
        <Presence show={kbd} exit={{ ...EXIT.dialog, duration: 0 }} enter={{ initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: 0.25 } }}>
          <div style={{ display: 'flex', width: 90, height: 28, borderRadius: 10, backgroundColor: fill, alignItems: 'center', justifyContent: 'center' }}><Label color={t.text} size={13}>Presence (w)</Label></div>
        </Presence>
      </div>
      {/* Chevrons */}
      <div testId="chevrons" style={{ ...at(16, 340, 120, 32), alignItems: 'center', gap: 16 }}>
        <Chevron open={turned} color={t.text} size={20} /><Chevron open={turned} color={t.text} size={20} turn={180} source={N.chevronDown} duration={0.25} />
      </div>
      {/* Meters */}
      <div testId="meters" style={{ ...at(150, 340, 220, 80), gap: 16, alignItems: 'flex-end' }}>
        <MeterFill value={meter} length={140} thickness={8} radius={4} color={t.green} play />
        <MeterFill key={meter === 0 ? 'z' : 'n'} value={meter} axis="y" length={60} thickness={8} radius={4} color={t.link} play />
      </div>
      {/* Arc */}
      <div testId="arc" style={at(400, 340, 56, 56)}>
        <div style={{ position: 'relative', display: 'flex', width: 48, height: 48, margin: 4 }}>
          <svg source={ringArc({ size: 48, radius: 20, strokeWidth: 4, fraction: 1 }).source} style={{ position: 'absolute', left: 0, top: 0, width: 48, height: 48, color: ink(t, 0.12) }} />
          {arc > 0 && <svg key={arc} source={ring.source} {...(arcDraw(ring.length) ? { paintAnimation: arcDraw(ring.length) } : {})} style={{ position: 'absolute', left: 0, top: 0, width: 48, height: 48, color: t.green }} />}
        </div>
      </div>
      {/* Reveal */}
      <div testId="reveal" style={{ ...at(16, 430, 240, 32), alignItems: 'center', justifyContent: 'space-between', paddingLeft: 10, paddingRight: 8, borderRadius: 10, backgroundColor: fill }}>
        <Label color={t.text} size={13}>Row with actions</Label>
        <div paintTransform={revealTransform(hovered)} style={{ display: 'flex', gap: 4 }}><Icon source={N.chevronRight} size={16} color={t.text} /><Icon source={N.chevronDown} size={16} color={t.text} /></div>
      </div>
      {/* Hover scale + press row + count pop */}
      <div testId="hover-btn" onMouseEnter={() => setHoverBtn(true)} onMouseLeave={() => setHoverBtn(false)} paintTransform={hoverPressTransform(hoverBtn)} style={{ ...at(300, 430, 36, 36), borderRadius: 18, backgroundColor: t.v('--primary'), alignItems: 'center', justifyContent: 'center' }}><Icon source={N.chevronRight} size={16} color={t.v('--primary-foreground')} /></div>
      <div testId="press-row" style={{ ...at(360, 430, 200, 32), alignItems: 'center', paddingLeft: 10, borderRadius: 10, hover: { backgroundColor: t.buttonSecondaryHover }, ...pressRowStyle(t, t.buttonSecondaryHover) }}><Label color={t.text} size={13}>Press row (hold)</Label></div>
      <div testId="count" style={{ ...at(600, 430, 80, 32), alignItems: 'center' }}><Label key={countKey} color={t.text} size={18} weight={600} paintAnimation={popAnimation()}>{String(count)}</Label></div>
    </div>
  )
}
// Every React commit anywhere in the lab is logged: a paint-only tween must add none between its first and last frame.
render(<ThemeProvider><Profiler id="lab" onRender={() => { console.error(`[lab-commit] ${++commits}`) }}><Lab /></Profiler></ThemeProvider>, { title: 'motion-p0', width: 960, height: 520, focus: false })
