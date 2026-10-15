import '../native/local-build.ts'
import { render } from '@gpuix/react'
import { useState } from 'react'
import { PopupLayer, popoverStyle } from './Menu.tsx'
import { Label, ThemeProvider, useTheme } from '../ui.tsx'

function Fixture() {
  const t = useTheme(), [open, setOpen] = useState(false)
  return <div testId="popup-ready" style={{ display: 'flex', width: '100%', height: '100%', padding: 80, backgroundColor: t.surface }}>
    <div style={{ display: 'flex', position: 'relative' }}>
      <div testId="popup-trigger" role="button" onClick={() => setOpen(true)} style={{ padding: 10, backgroundColor: t.hover }}><Label color={t.text}>Open menu</Label></div>
      {open && <PopupLayer side="bottom" align="start" sideOffset={6} testId="popup-panel" onMouseDownOutside={() => setOpen(false)} style={{ ...popoverStyle(t), padding: 12 }}>
        <Label color={t.text}>Reduced motion popup</Label>
      </PopupLayer>}
    </div>
  </div>
}
render(<ThemeProvider><Fixture /></ThemeProvider>, { title: 'Popup reduced motion', width: 600, height: 400, focus: false })
process.stdin.on('end', () => process.exit(0))
