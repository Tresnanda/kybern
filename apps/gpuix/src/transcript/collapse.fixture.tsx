import '../native/local-build.ts'
import { render } from '@gpuix/react'
import { useState } from 'react'
import { Collapse } from '../motion/kit.tsx'
import { ThemeProvider, useTheme, Label } from '../ui.tsx'
import { Button } from '../kit/Button.tsx'
function Fixture() {
  const t = useTheme(), [open, setOpen] = useState(true), [lines, setLines] = useState(2)
  return <div testId="collapse-ready" style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', padding: 24, backgroundColor: t.surface }}>
    <Button testId="collapse-toggle" onClick={() => setOpen(v => !v)}>Toggle</Button>
    <Button testId="collapse-grow" onClick={() => setLines(v => v + 3)}>Grow</Button>
    <Collapse open={open} testId="collapse-body"><div style={{ height: lines * 30, backgroundColor: t.hover }}><Label color={t.text}>Disclosure content</Label></div></Collapse>
    <div testId="collapse-after" style={{ height: 30, backgroundColor: t.codeSurface }}><Label color={t.text}>Following content</Label></div>
  </div>
}
render(<ThemeProvider><Fixture /></ThemeProvider>, { title: 'Collapse verification', width: 600, height: 500, focus: false })
process.stdin.on('end', () => process.exit(0))
