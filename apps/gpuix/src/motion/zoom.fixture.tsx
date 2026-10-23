// The zoomable image preview in its own window, for `zoom.verify.ts`: the lightbox (`ZOOM_MODE=lightbox`, the default) or the
// image tab's pane (`ZOOM_MODE=tab`) on `ZOOM_IMAGE`.
import '../native/local-build.ts'
import { render } from '@gpuix/react'
import { useState } from 'react'
import { ImageViewer } from './ImageMorph.tsx'
import { ZoomPane } from './ZoomSurface.tsx'
import { Label, ThemeProvider, useTheme } from '../ui.tsx'

const image = process.env.ZOOM_IMAGE ?? ''

function Fixture() {
  const t = useTheme(), [open, setOpen] = useState(true)
  const tab = process.env.ZOOM_MODE === 'tab'
  return <div testId="zoom-ready" style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', backgroundColor: t.surface }}>
    {tab
      ? <div style={{ display: 'flex', flexGrow: 1, minHeight: 0 }}><ZoomPane src={image} label="family-dark.png" /></div>
      : <div style={{ display: 'flex', padding: 24 }}>
        <Label color={t.text}>{open ? 'Preview open' : 'Preview closed'}</Label>
        {open && <ImageViewer testId="image-lightbox" src={image} label="family-dark.png" from={null} source={() => null} onClose={() => setOpen(false)} onOpenInTab={() => {}} />}
      </div>}
  </div>
}
const [width, height] = (process.env.ZOOM_WINDOW ?? '1200x800').split('x').map(Number)
render(<ThemeProvider><Fixture /></ThemeProvider>, { title: 'Zoom', width, height, focus: false })
process.stdin.on('end', () => process.exit(0))
