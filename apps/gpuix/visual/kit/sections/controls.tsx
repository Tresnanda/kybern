// Desktop reference for the `controls` group: Switch, Checkbox, Toggle, SegmentedControl, TimePicker, each cell at a
// fixed absolute position so the GPUIX twin (`src/kit/gallery/controls.tsx`) lines up pixel for pixel.
import { useState, type ComponentType, type ReactNode } from 'react'
import { Switch } from '@/components/kit/switch'
import { Checkbox } from '@/components/kit/checkbox'
import { Toggle } from '@/components/kit/toggle'
import { SegmentedControl } from '@/components/kit/segmented-control'
import { TimePicker } from '@/components/kit/time-picker'
import { PinIcon } from '@/lib/kit/icons'

const At = ({ x, y, children }: { x: number; y: number; children: ReactNode }) => <div style={{ position: 'absolute', left: x, top: y, display: 'flex' }}>{children}</div>
const Caption = ({ x, y, children }: { x: number; y: number; children: string }) => <div style={{ position: 'absolute', left: x, top: y, fontSize: 11, lineHeight: '14px' }} className="text-muted-foreground">{children}</div>

const RANGE = [{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }] as const
const MODES = [{ value: 'auto', label: 'Auto' }, { value: 'ask', label: 'Ask' }, { value: 'full', label: 'Full access', unavailable: 'Needs a newer daemon' }]

function Controls() {
  const [range, setRange] = useState('week')
  const [mode, setMode] = useState('auto')
  const [time, setTime] = useState('09:30')
  return (
    <div style={{ position: 'relative', width: 1280, height: 820 }}>
      <Caption x={40} y={16}>Switch</Caption>
      <At x={40} y={40}><Switch data-testid="switch-a" /></At>
      <At x={96} y={40}><Switch data-testid="switch-b" defaultChecked /></At>
      <At x={152} y={40}><Switch disabled /></At>
      <At x={208} y={40}><Switch disabled defaultChecked /></At>

      <Caption x={40} y={84}>Checkbox</Caption>
      <At x={40} y={108}><Checkbox data-testid="check-a" /></At>
      <At x={80} y={108}><Checkbox data-testid="check-b" defaultChecked /></At>
      <At x={120} y={108}><Checkbox indeterminate /></At>
      <At x={160} y={108}><Checkbox disabled /></At>
      <At x={200} y={108}><Checkbox disabled defaultChecked /></At>
      <At x={240} y={108}><Checkbox aria-invalid /></At>

      <Caption x={40} y={148}>Toggle</Caption>
      <At x={40} y={172}><Toggle data-testid="toggle-a">Bold</Toggle></At>
      <At x={110} y={172}><Toggle data-testid="toggle-b" defaultPressed>Bold</Toggle></At>
      <At x={180} y={172}><Toggle data-testid="toggle-c" variant="outline">Italic</Toggle></At>
      <At x={250} y={172}><Toggle variant="outline" defaultPressed>Italic</Toggle></At>
      <At x={320} y={172}><Toggle data-testid="toggle-icon" aria-label="Pin"><PinIcon /></Toggle></At>
      <At x={370} y={172}><Toggle disabled>Off</Toggle></At>
      <At x={40} y={220}><Toggle size="xs">xs</Toggle></At>
      <At x={90} y={220}><Toggle size="sm" variant="outline">Small</Toggle></At>
      <At x={170} y={220}><Toggle data-testid="toggle-pin" size="default" variant="outline"><PinIcon />Pin</Toggle></At>
      <At x={260} y={220}><Toggle size="lg" variant="outline" defaultPressed>Large</Toggle></At>

      <Caption x={40} y={272}>Segmented</Caption>
      <At x={40} y={296}><div data-testid="seg-a"><SegmentedControl aria-label="Range" options={RANGE} value={range} onChange={setRange} /></div></At>
      <At x={260} y={296}><div data-testid="seg-b"><SegmentedControl aria-label="Mode" options={MODES} value={mode} onChange={setMode} /></div></At>
      <At x={520} y={296}><SegmentedControl aria-label="Busy" busy options={RANGE} value="day" onChange={() => {}} /></At>

      <Caption x={40} y={348}>Time picker</Caption>
      <At x={40} y={372}><div data-testid="time" style={{ width: 168 }}><TimePicker value={time} onChange={setTime} /></div></At>
      <Caption x={240} y={372}>{time}</Caption>
    </div>
  )
}

/** One checkbox, large margin, for check-draw frame strips. */
function CheckDraw() {
  return <div style={{ position: 'relative', width: 1280, height: 820 }}><At x={40} y={40}><Checkbox data-testid="check-a" /></At><At x={80} y={40}><Switch data-testid="switch-a" /></At></div>
}

export const sections: Record<string, ComponentType> = { controls: Controls, 'controls-motion': CheckDraw }
