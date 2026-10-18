// Toast cross-fade lab: the app's own Toaster in a bare window. Keys: a toast, b second toast (stacks), c third, r replace
// toast `a` in place with new text, x dismiss every toast, 1 error toast with a description and an action.
import '../src/native/local-build.ts'
import { render } from '@gpuix/react'
import { ThemeProvider, useTheme } from '../src/ui.tsx'
import { Toaster, toast } from '../src/shell/toasts.tsx'

// Strips pause the animation clock but JS timers keep real time: stretch the toaster's own removal timers (a
// leaving toast's 190/160 ms, a retired layer's 210/180 ms) so the exit frames can be captured before they fire.
if (process.env.TOAST9_HOLD === '1') {
  const real = globalThis.setTimeout
  globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => real(fn, ms !== undefined && [190, 160, 210, 180].includes(ms) ? ms * 25 : ms, ...rest)) as typeof setTimeout
}

function Lab() {
  const t = useTheme()
  const action = (k: string) => {
    if (k === 'a') toast('Saved to “Notes”', { id: 'a', duration: Infinity, action: { label: 'Open', onClick: () => {} } })
    if (k === 'b') toast.success('Thread archived', { id: 'b', duration: Infinity })
    if (k === 'c') toast.info('Reconnected to the daemon', { id: 'c', duration: Infinity })
    if (k === 'r') toast('Saved to “Tasks”', { id: 'a', duration: Infinity, action: { label: 'Open', onClick: () => {} } })
    if (k === 'x') toast.dismiss()
    if (k === '1') toast.error('Unable to load thread', { id: 'e', duration: Infinity, description: 'The daemon did not answer. Check the connection and try again.' })
  }
  return <div testId="app-ready" onKeyDown={e => action(e.key ?? '')} style={{ position: 'relative', width: '100%', height: '100%', backgroundColor: t.v('--background') }}>
    <Toaster />
  </div>
}
render(<ThemeProvider><Lab /></ThemeProvider>, { title: 'toast9 lab', width: 520, height: 300, focus: false })
