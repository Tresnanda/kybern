// Desktop kit gallery: renders one section of the desktop's own kit components at a fixed place, with the
// app's stylesheets and theme provider. `?section=<name>&theme=dark|light`. The GPUIX twin is
// `src/kit/gallery/index.tsx`; both lay a section out identically so the two can be compared pixel to pixel.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/jetbrains-mono/index.css'
import '@fontsource/cal-sans/index.css'
import './gallery.css'
import { ThemeProvider } from '@/components/theme-provider'
import { TooltipProvider } from '@/components/kit/tooltip'
import { sections } from './sections/index'

const params = new URLSearchParams(location.search)
const name = params.get('section') ?? 'hello'
const Section = sections[name]
if (params.get('theme')) localStorage.setItem('kybern.theme', params.get('theme')!)
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider defaultTheme="system" storageKey="kybern.theme">
      <TooltipProvider>
        <div data-gallery={name} className="bg-background text-foreground" style={{ width: 1280, height: 820, position: 'relative', overflow: 'hidden' }}>
          {Section ? <Section /> : <div>unknown section {name}</div>}
        </div>
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
)
