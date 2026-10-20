// Motion kit lab: Collapse inside a <virtual-list> row and in a plain column,
// with rows after it, so frames show whether the list follows the tween.
//   bun scripts/motion-lab.tsx            (driven by scripts/motion-lab-run.ts)
import { render } from '@gpuix/react'
import { useState } from 'react'
import { Collapse, Rise } from '../src/motion/kit.tsx'
import { ThemeProvider, Label, useTheme } from '../src/ui.tsx'

function Rows({ n, label }: { n: number; label: string }) {
  const t = useTheme()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: 8, backgroundColor: '#262626', borderRadius: 8 }}>
      {Array.from({ length: n }, (_, i) => (
        <Label key={i} color={t.text}>{`${label} line ${i + 1}`}</Label>
      ))}
    </div>
  )
}

function Lab() {
  const t = useTheme()
  const [open, setOpen] = useState(false)
  const [rise, setRise] = useState(0)
  const toggle = (id: string) => (
    <div testId={id} onClick={() => setOpen(!open)} style={{ padding: 8, backgroundColor: '#3a3a3a', borderRadius: 8, cursor: 'pointer' }}>
      <Label color={t.text}>{open ? 'Close' : 'Open'}</Label>
    </div>
  )
  return (
    <div testId="app-ready" style={{ display: 'flex', width: '100%', height: '100%', backgroundColor: '#181818', gap: 24, padding: 24 }}>
      <div style={{ display: 'flex', flexDirection: 'column', width: 360, height: 700 }}>
        <Label color={t.textSecondary}>virtual-list</Label>
        <virtual-list estimatedItemHeight={40} style={{ flexGrow: 1, minHeight: 0 }}>
          {[
            <div key="t" style={{ paddingBottom: 8 }}>{toggle('toggle-list')}</div>,
            <div key="c" style={{ paddingBottom: 8 }}><Collapse open={open}><Rows n={6} label="virtual" /></Collapse></div>,
            ...Array.from({ length: 6 }, (_, i) => (
              <div key={`r${i}`} style={{ paddingBottom: 8 }}><Rows n={1} label={`after ${i + 1}`} /></div>
            )),
          ]}
        </virtual-list>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', width: 360, gap: 8 }}>
        <Label color={t.textSecondary}>plain column</Label>
        {toggle('toggle')}
        <Collapse open={open}><Rows n={6} label="plain" /></Collapse>
        {Array.from({ length: 3 }, (_, i) => <Rows key={i} n={1} label={`after ${i + 1}`} />)}
        <div testId="rise" onClick={() => setRise(rise + 1)} style={{ padding: 8, backgroundColor: '#3a3a3a', borderRadius: 8 }}><Label color={t.text}>Add row</Label></div>
        {Array.from({ length: rise }, (_, i) => <Rise key={i}><Rows n={1} label={`risen ${i + 1}`} /></Rise>)}
      </div>
    </div>
  )
}
render(<ThemeProvider><Lab /></ThemeProvider>, { title: 'motion-lab', width: 900, height: 780, focus: process.env.GPUIX_BACKGROUND !== '1' })
