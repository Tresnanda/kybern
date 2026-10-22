// GPUIX twin of `visual/kit/sections/controls.tsx`: the same controls at the same absolute positions.
import { useState, type ComponentType, type ReactNode } from 'react'
import { N } from '../../nav/glyphs.ts'
import { Label, useTheme } from '../../ui.tsx'
import { Checkbox } from '../Checkbox.tsx'
import { Segmented } from '../Segmented.tsx'
import { Slider } from '../Slider.tsx'
import { Switch } from '../Switch.tsx'
import { TimePicker } from '../TimePicker.tsx'
import { IconButton } from '../IconButton.tsx'
import type { ControlSize } from '../controls.ts'

const At = ({ x, y, children }: { x: number; y: number; children: ReactNode }) => <div style={{ position: 'absolute', left: x, top: y, display: 'flex' }}>{children}</div>
function Caption({ x, y, children }: { x: number; y: number; children: string }) {
  const t = useTheme()
  return <div style={{ position: 'absolute', left: x, top: y }}><Label color={t.v('--muted-foreground')} size={11} lineHeight={14}>{children}</Label></div>
}

const RANGE = [{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }] as const
const MODES = [{ value: 'auto', label: 'Auto' }, { value: 'ask', label: 'Ask' }, { value: 'full', label: 'Full access', unavailable: 'Needs a newer daemon' }]

/** A stateful `IconButton(active)`: the kit's toggle. */
function Pressed({ label, testId, size, defaultOn = false }: { label: string; testId?: string; size?: ControlSize; defaultOn?: boolean }) {
  const [on, setOn] = useState(defaultOn)
  return <IconButton testId={testId} icon={N.pin} label={label} size={size} active={on} onClick={() => setOn(!on)} />
}

function Controls() {
  const [range, setRange] = useState('week')
  const [mode, setMode] = useState('auto')
  const [time, setTime] = useState('09:30')
  const [opacity, setOpacity] = useState(90)
  return (
    <div style={{ position: 'relative', width: 1280, height: 820 }}>
      <Caption x={40} y={16}>Switch</Caption>
      <At x={40} y={40}><Switch testId="switch-a" aria-label="Switch A" /></At>
      <At x={96} y={40}><Switch testId="switch-b" aria-label="Switch B" defaultChecked /></At>
      <At x={152} y={40}><Switch disabled /></At>
      <At x={208} y={40}><Switch disabled defaultChecked /></At>

      <Caption x={40} y={84}>Checkbox</Caption>
      <At x={40} y={108}><Checkbox testId="check-a" aria-label="Check A" /></At>
      <At x={80} y={108}><Checkbox testId="check-b" aria-label="Check B" defaultChecked /></At>
      <At x={120} y={108}><Checkbox indeterminate /></At>
      <At x={160} y={108}><Checkbox disabled /></At>
      <At x={200} y={108}><Checkbox disabled defaultChecked /></At>
      <At x={240} y={108}><Checkbox invalid /></At>

      <Caption x={40} y={148}>Icon toggle</Caption>
      <At x={40} y={172}><Pressed testId="toggle-a" label="Bold" /></At>
      <At x={80} y={172}><Pressed testId="toggle-b" label="Bold" defaultOn /></At>
      <At x={120} y={172}><Pressed testId="toggle-c" label="Italic" /></At>
      <At x={160} y={172}><Pressed label="Italic" defaultOn /></At>
      <At x={200} y={172}><Pressed testId="toggle-icon" label="Pin" /></At>
      <At x={240} y={172}><IconButton icon={N.pin} label="Off" disabled /></At>
      <At x={40} y={220}><Pressed size="sm" label="Small" /></At>
      <At x={80} y={220}><Pressed testId="toggle-pin" label="Pin" /></At>
      <At x={120} y={220}><Pressed size="lg" label="Large" defaultOn /></At>

      <Caption x={40} y={272}>Segmented</Caption>
      <At x={40} y={296}><Segmented testId="seg-a" aria-label="Range" options={RANGE} value={range} onChange={setRange} /></At>
      <At x={260} y={296}><Segmented testId="seg-b" aria-label="Mode" options={MODES} value={mode} onChange={setMode} /></At>
      <At x={520} y={296}><Segmented aria-label="Busy" busy options={RANGE} value="day" onChange={() => {}} /></At>

      <Caption x={40} y={348}>Time picker</Caption>
      <At x={40} y={372}><TimePicker testId="time" width={168} value={time} onChange={setTime} /></At>
      <Caption x={240} y={372}>{time}</Caption>

      <Caption x={40} y={424}>Slider</Caption>
      <At x={40} y={448}><Slider testId="slider-a" aria-label="Opacity" ariaValueText={`${opacity} percent`} value={opacity} min={15} max={100} onChange={setOpacity} onCommit={setOpacity} valueLabel={`${opacity}%`} /></At>
      <At x={300} y={448}><Slider testId="slider-auto" aria-label="Blur" ariaValueText="Automatic" value={30} min={1} max={64} onChange={() => {}} onCommit={() => {}} valueLabel="Auto" muted /></At>
    </div>
  )
}

function CheckDraw() {
  return <div style={{ position: 'relative', width: 1280, height: 820 }}><At x={40} y={40}><Checkbox testId="check-a" /></At><At x={80} y={40}><Switch testId="switch-a" /></At></div>
}

export const sections: Record<string, ComponentType> = { controls: Controls, 'controls-motion': CheckDraw }
