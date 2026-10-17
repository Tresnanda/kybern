// GPUIX twin of `visual/kit/sections/controls.tsx`: the same controls at the same absolute positions.
import { useState, type ComponentType, type ReactNode } from 'react'
import { N } from '../../nav/glyphs.ts'
import { Label, useTheme } from '../../ui.tsx'
import { Checkbox } from '../Checkbox.tsx'
import { Segmented } from '../Segmented.tsx'
import { Switch } from '../Switch.tsx'
import { TimePicker } from '../TimePicker.tsx'
import { Toggle } from '../Toggle.tsx'

const At = ({ x, y, children }: { x: number; y: number; children: ReactNode }) => <div style={{ position: 'absolute', left: x, top: y, display: 'flex' }}>{children}</div>
function Caption({ x, y, children }: { x: number; y: number; children: string }) {
  const t = useTheme()
  return <div style={{ position: 'absolute', left: x, top: y }}><Label color={t.v('--muted-foreground')} size={11} lineHeight={14}>{children}</Label></div>
}

const RANGE = [{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }] as const
const MODES = [{ value: 'auto', label: 'Auto' }, { value: 'ask', label: 'Ask' }, { value: 'full', label: 'Full access', unavailable: 'Needs a newer daemon' }]

function Controls() {
  const [range, setRange] = useState('week')
  const [mode, setMode] = useState('auto')
  const [time, setTime] = useState('09:30')
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

      <Caption x={40} y={148}>Toggle</Caption>
      <At x={40} y={172}><Toggle testId="toggle-a">Bold</Toggle></At>
      <At x={110} y={172}><Toggle testId="toggle-b" defaultPressed>Bold</Toggle></At>
      <At x={180} y={172}><Toggle testId="toggle-c" variant="outline">Italic</Toggle></At>
      <At x={250} y={172}><Toggle variant="outline" defaultPressed>Italic</Toggle></At>
      <At x={320} y={172}><Toggle testId="toggle-icon" aria-label="Pin" icon={N.pin} /></At>
      <At x={370} y={172}><Toggle disabled>Off</Toggle></At>
      <At x={40} y={220}><Toggle size="xs">xs</Toggle></At>
      <At x={90} y={220}><Toggle size="sm" variant="outline">Small</Toggle></At>
      <At x={170} y={220}><Toggle testId="toggle-pin" size="default" variant="outline" icon={N.pin}>Pin</Toggle></At>
      <At x={260} y={220}><Toggle size="lg" variant="outline" defaultPressed>Large</Toggle></At>

      <Caption x={40} y={272}>Segmented</Caption>
      <At x={40} y={296}><Segmented testId="seg-a" aria-label="Range" textSize={16} options={RANGE} value={range} onChange={setRange} /></At>
      <At x={260} y={296}><Segmented testId="seg-b" aria-label="Mode" textSize={16} options={MODES} value={mode} onChange={setMode} /></At>
      <At x={520} y={296}><Segmented aria-label="Busy" busy textSize={16} options={RANGE} value="day" onChange={() => {}} /></At>

      <Caption x={40} y={348}>Time picker</Caption>
      <At x={40} y={372}><TimePicker testId="time" width={168} value={time} onChange={setTime} /></At>
      <Caption x={240} y={372}>{time}</Caption>
    </div>
  )
}

function CheckDraw() {
  return <div style={{ position: 'relative', width: 1280, height: 820 }}><At x={40} y={40}><Checkbox testId="check-a" /></At><At x={80} y={40}><Switch testId="switch-a" /></At></div>
}

export const sections: Record<string, ComponentType> = { controls: Controls, 'controls-motion': CheckDraw }
