// Shell lab: toasts, the connection banner and an error boundary on a bare card,
// without a daemon. Driven by scripts/shell-lab-run.ts.
//   bun scripts/shell-lab.tsx
import { render } from '@gpuix/react'
import { useState } from 'react'
import { set } from '../src/state.ts'
import { ConnectionBanner, Welcome } from '../src/shell/Connection.tsx'
import { ErrorBoundary } from '../src/shell/ErrorBoundary.tsx'
import { toast, Toaster } from '../src/shell/toasts.tsx'
import { Label, ThemeProvider, useTheme } from '../src/ui.tsx'

function Btn({ id, label, onClick }: { id: string; label: string; onClick: () => void }) {
  const t = useTheme()
  return (
    <div testId={id} onClick={onClick} style={{ padding: 8, borderRadius: 8, backgroundColor: t.buttonSecondary, cursor: 'pointer' }}>
      <Label color={t.text}>{label}</Label>
    </div>
  )
}

function Bomb({ armed }: { armed: boolean }) {
  if (armed) throw new Error('Cannot read properties of undefined (reading "title")')
  return <Label color="#999999">Healthy surface</Label>
}

function Lab() {
  const t = useTheme()
  const [armed, setArmed] = useState(false)
  const [welcome, setWelcome] = useState<'connecting' | 'unavailable' | 'empty' | null>(null)
  return (
    <div testId="app-ready" style={{ display: 'flex', width: '100%', height: '100%', backgroundColor: t.frame, padding: 24, gap: 24 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: 220 }}>
        <Btn id="t-default" label="toast" onClick={() => toast('Thread is no longer available')} />
        <Btn id="t-success" label="toast success" onClick={() => toast.success('Saved to “Notes”', { action: { label: 'Open', onClick: () => {} } })} />
        <Btn id="t-error" label="toast error" onClick={() => toast.error('Unable to load thread', { description: 'Connection interrupted. Check the environment, then try again.' })} />
        <Btn id="t-agent" label="agent toast" onClick={() => toast('Fix the sidebar width', { id: 'a1', description: 'Needs approval: bash: git status', duration: Infinity, action: { label: 'Open thread', onClick: () => {} } })} />
        <Btn id="t-dismiss" label="dismiss a1" onClick={() => toast.dismiss('a1')} />
        <Btn id="t-many" label="five toasts" onClick={() => [1, 2, 3, 4, 5].forEach((n) => toast(`Toast ${n}`, { description: n % 2 ? 'With a description line' : undefined }))} />
        <Btn id="b-reconnecting" label="banner reconnecting" onClick={() => set({ status: 'reconnecting', statusDetail: 'Connection interrupted' })} />
        <Btn id="b-failed" label="banner failed" onClick={() => set({ status: 'failed', statusDetail: 'The token was rejected. Reopen kybern.' })} />
        <Btn id="b-open" label="banner off" onClick={() => set({ status: 'open', statusDetail: null })} />
        <Btn id="boom" label="throw" onClick={() => setArmed(true)} />
        <Btn id="w-connecting" label="welcome connecting" onClick={() => setWelcome('connecting')} />
        <Btn id="w-unavailable" label="welcome unavailable" onClick={() => setWelcome('unavailable')} />
        <Btn id="w-empty" label="welcome empty" onClick={() => setWelcome('empty')} />
        <Btn id="w-off" label="welcome off" onClick={() => setWelcome(null)} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0, borderRadius: 12, backgroundColor: t.surface, borderWidth: 0.6, borderColor: t.border }}>
        {welcome ? (
          <Welcome kind={welcome} />
        ) : (
          <ErrorBoundary label="this page" key="boundary">
            <Bomb armed={armed} />
          </ErrorBoundary>
        )}
        <ConnectionBanner />
      </div>
      <Toaster />
    </div>
  )
}
render(<ThemeProvider><Lab /></ThemeProvider>, { title: 'shell-lab', width: 1100, height: 780, focus: process.env.GPUIX_BACKGROUND !== '1' })
