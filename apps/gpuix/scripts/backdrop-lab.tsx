// Dialog backdrop lab: a white page under a backdrop layer, no daemon.
//   BACKDROP_MODE=dialog|rgba|rgbaFade  bun scripts/backdrop-lab-run.ts out.png light
import { render, useWindowSize } from '@gpuix/react'
import { PopupLayer } from '../src/composer/Menu.tsx'
import { Dialog } from '../src/nav/overlay.tsx'
import { Label, ThemeProvider } from '../src/ui.tsx'

const mode = process.env.BACKDROP_MODE ?? 'dialog'
const dim = Number(process.env.BACKDROP_DIM ?? 0.6)
function Backdrop() {
  const size = useWindowSize({ intervalMs: 250 })
  if (mode === 'dialog') return <Dialog onClose={() => {}} width={300} dim={dim}><Label color="#000000">Dialog</Label></Dialog>
  if (mode === 'old') return <PopupLayer fade={{ opacity: dim }} position={{ x: 0, y: 0 }} priority={3} style={{ width: size.width, height: size.height, backgroundColor: '#000000' }} />
  if (mode === 'new') return <PopupLayer fade={{}} backing={`rgba(0, 0, 0, ${dim})`} position={{ x: 0, y: 0 }} priority={3} style={{ width: size.width, height: size.height }} />
  if (mode.startsWith('raw')) {
    const bg = mode === 'rawClear' ? { backgroundColor: 'rgba(0,0,0,0)' } : mode === 'rawBg' ? { backgroundColor: `rgba(0, 0, 0, ${dim})` } : {}
    return (
      <anchored position={{ x: 0, y: 0 }} fit="snap" deferred priority={3} occlude style={bg}>
        <div style={{ width: size.width, height: size.height, backgroundColor: mode === 'rawBg' ? 'rgba(0,0,0,0)' : `rgba(0, 0, 0, ${dim})` }} />
      </anchored>
    )
  }
  return (
    <PopupLayer still position={{ x: 0, y: 0 }} priority={3} style={{ width: size.width, height: size.height, backgroundColor: mode === 'rgba' ? `rgba(0, 0, 0, ${dim})` : '#000000', ...(mode === 'rgbaFade' ? { opacity: dim } : {}) }} />
  )
}
render(
  <ThemeProvider>
    <div testId="app-ready" style={{ display: 'flex', width: '100%', height: '100%', backgroundColor: process.env.BACKDROP_PAGE ?? '#ffffff' }}>
      <Backdrop />
    </div>
  </ThemeProvider>,
  { title: 'backdrop-lab', width: 640, height: 400, titlebarTransparent: true, windowBackground: 'opaque', focus: false },
)
