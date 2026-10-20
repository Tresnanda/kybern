// motion10 press lab: a sample of the controls wired with press feedback in motion10 (dock `Action`, environments `EnvButton`,
// editor `FormatButton`, dock `DockFooter`), laid out like `motion10-press-webkit.mjs` (the desktop's motion CSS in WebKit).
// Presses are real mouse down/up on `press-*`.
import '../src/native/local-build.ts'
import { render } from '@gpuix/react'
import { ThemeProvider, useTheme } from '../src/ui.tsx'
import { Action } from '../src/dock/parts.tsx'
import { DockFooter } from '../src/dock/Notes.tsx'
import { EnvButton } from '../src/environments/kit.tsx'
import { FormatButton } from '../src/editor/FormatBar.tsx'
import { SLASH_ICON } from '../src/editor/icons.ts'

function Lab() {
  const t = useTheme()
  return <div testId="app-ready" style={{ position: 'relative', width: '100%', height: '100%', backgroundColor: t.v('--background') }}>
    <div testId="press-action" style={{ position: 'absolute', left: 24, top: 24, display: 'flex' }}><Action onClick={() => {}}>Stop all</Action></div>
    <div testId="press-env" style={{ position: 'absolute', left: 24, top: 72, display: 'flex' }}><EnvButton onClick={() => {}}>Connect</EnvButton></div>
    <div testId="press-format" style={{ position: 'absolute', left: 160, top: 24, display: 'flex' }}><FormatButton icon={SLASH_ICON.heading1} label="Heading 1" onClick={() => {}} /></div>
    <div testId="press-footer" style={{ position: 'absolute', left: 154, top: 68, width: 180, display: 'flex', flexDirection: 'column' }}><DockFooter testId="footer" onClick={() => {}}>Show all in Notes</DockFooter></div>
  </div>
}
render(<ThemeProvider><Lab /></ThemeProvider>, { title: 'motion10 press', width: 360, height: 140, focus: false })
