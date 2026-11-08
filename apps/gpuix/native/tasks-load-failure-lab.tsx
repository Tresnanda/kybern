// Lab for tasks-load-failure-check.ts (#299): the All tasks page when its first load failed, as `TasksPage` shows it in
// place of "Loading tasks…". KYBERN_LAB_ERROR picks the cause: `busy` (the daemon was full) or `offline` (it cannot be
// reached). "Try again" never finishes here, so the busy button stays on screen for the check.
import '../src/native/local-build.ts'
import { render, useGpuixRequired } from '@gpuix/react'
import { readFileSync } from 'node:fs'
import { useEffect, useState } from 'react'
import { installUiFont } from '../src/platform/fonts.ts'
import { ThemeProvider, useTheme } from '../src/ui.tsx'
import { RpcCallError } from '../../../packages/kybern-client/src/client.ts'
import { codes } from '../../../packages/kybern-client/src/types.ts'
import { LoadFailure } from '../src/tasks/LoadFailure.tsx'

const FONTS = ['CalSans-Regular.ttf', 'JetBrainsMono-Regular.ttf', 'JetBrainsMono-Light.ttf', 'JetBrainsMono-Medium.ttf', 'JetBrainsMono-LightItalic.ttf', 'JetBrainsMono-MediumItalic.ttf']
function Fonts({ children }: { children: React.ReactNode }) {
  const renderer = useGpuixRequired()
  const [ready, setReady] = useState(false)
  useEffect(() => {
    for (const file of FONTS) renderer.registerFont!(readFileSync(new URL(`../src/assets/fonts/${file}`, import.meta.url)))
    installUiFont(renderer)
    setReady(true)
  }, [renderer])
  return ready ? children : null
}

const busy = new RpcCallError({
  code: codes.CAPACITY_EXCEEDED,
  message: 'Too many calls in flight on this connection; try again in a moment',
  data: { problem: { kind: 'conflict', subject: 'busy', retryable: true } },
})
const offline = Object.assign(new Error('SatyaMas is offline. Try again when it reconnects.'), { name: 'OfflineError' })

function Lab() {
  const t = useTheme()
  return <div testId="app-ready" style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', backgroundColor: t.v('--background') }}>
    <LoadFailure error={process.env.KYBERN_LAB_ERROR === 'offline' ? offline : busy} retry={() => new Promise<void>(() => {})} />
  </div>
}
render(<ThemeProvider><Fonts><Lab /></Fonts></ThemeProvider>, { title: 'Tasks load failure', width: 760, height: 420, focus: false })
