import '../native/local-build.ts'
import { render } from '@gpuix/react'
import { connect, getState, selectThread, subscribe } from '../state.ts'
import { Transcript } from '../Transcript.tsx'
import { NotesOverlays } from '../notes/Overlays.tsx'
import { ThemeProvider, useTheme } from '../ui.tsx'
connect()
const off = subscribe(() => { if (getState().status === 'open') { off(); void selectThread(process.env.KYBERN_GPUIX_THREAD!) } })
function Fixture() { const t = useTheme(); return <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', backgroundColor: t.surface }}><Transcript /><NotesOverlays /></div> }
render(<ThemeProvider><Fixture /></ThemeProvider>, { title: 'Save to note verification', width: 1280, height: 820, focus: false })
process.stdin.on('end', () => process.exit(0))
