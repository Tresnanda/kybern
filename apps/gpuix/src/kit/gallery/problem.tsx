// The three forms of a failure (`kit/Problem.tsx`): `ProblemState` in three panes, `ProblemRow` in three sections, and one `toast.problem`.
// `KIT_SECTION=problem`; `scripts/kit-problem-check.ts` drives it and captures it in light, dark, glass and increased contrast.
// The buttons record what was pressed instead of running a fix, so a check can press them without installing or signing in to anything.
import { useEffect, useState, type ComponentType } from 'react'
import { Label, useTheme } from '../../ui.tsx'
import { toast, Toaster } from '../../shell/toasts.tsx'
import { ProblemRow, ProblemState, type ProblemProps } from '../Problem.tsx'

type Spec = Omit<ProblemProps, 'primary' | 'secondary' | 'testId'> & { primary?: string; secondary?: string }

const SPECS: Spec[] = [
  { tone: 'info', icon: 'console', title: 'Install GitHub CLI to see pull requests', body: 'Kybern reads pull requests and Actions runs through the GitHub CLI.', primary: 'Install GitHub CLI', secondary: 'Check again', detail: 'exec: "gh": executable file not found in %PATH%\nrun gh pr list --json number,title,state: exit status 127' },
  { tone: 'warning', icon: 'lock', title: 'Claude Code is signed out', body: 'Sign in again to keep working with this account. Your threads are kept.', primary: 'Sign in', secondary: 'Use another account', detail: 'claude: OAuth token expired (401 authentication_error)' },
  { tone: 'neutral', icon: 'offline', title: 'SatyaMas is offline', body: 'Your work there is safe. This thread opens again when SatyaMas reconnects.', primary: 'Try again', detail: 'ws://100.84.12.7:4199/ws: connection refused (os error 10061)' },
]

const ROWS: Spec[] = [
  { tone: 'warning', icon: 'lock', title: 'Claude Code is signed out', body: 'Sign in again to keep using this account.', primary: 'Sign in', secondary: 'Use another account', detail: 'claude: OAuth token expired (401 authentication_error)' },
  { tone: 'neutral', icon: 'offline', title: 'SatyaMas is offline', body: 'Threads on SatyaMas are safe and open again when it reconnects.', primary: 'Try again' },
  { tone: 'danger', icon: 'failed', title: 'Windows build failed', body: 'The NSIS step couldn’t find the signed daemon. Fix it or rerun the job.', primary: 'Rerun job', detail: 'makensis: File: "kybernd.exe" -> no files found.' },
]

function Problems() {
  const t = useTheme()
  const [pressed, setPressed] = useState('none')
  useEffect(() => {
    toast.problem('Couldn’t start the thread on SatyaMas', {
      id: 'problem-gallery', tone: 'neutral', icon: 'offline', description: 'SatyaMas is offline. Your draft is kept.', duration: Infinity,
      action: { label: 'Try again', onClick: () => setPressed('toast-action') },
      secondary: { label: 'Copy', onClick: () => setPressed('toast-secondary') },
    })
    return () => toast.dismiss('problem-gallery')
  }, [])
  const press = (id: string) => () => setPressed(id)
  const buttons = (spec: Spec, id: string) => ({
    primary: spec.primary ? { label: spec.primary, onClick: press(`${id}-primary`) } : undefined,
    secondary: spec.secondary ? { label: spec.secondary, onClick: press(`${id}-secondary`) } : undefined,
  })
  return (
    <div style={{ position: 'relative', width: 1280, height: 820 }}>
      <div style={{ position: 'absolute', left: 0, top: 0, width: 1280, height: 440, display: 'flex' }}>
        {SPECS.map((spec, i) => (
          <div key={i} style={{ display: 'flex', width: 426, flexShrink: 0, borderLeftWidth: i ? 1 : 0, borderColor: t.border }}>
            <ProblemState {...spec} {...buttons(spec, `state-${i}`)} testId={`state-${i}`} />
          </div>
        ))}
      </div>
      <div style={{ position: 'absolute', left: 0, top: 440, width: 1280, height: 380, borderTopWidth: 1, borderColor: t.border, display: 'flex' }}>
        {ROWS.map((spec, i) => (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 10, width: 400, padding: 24, flexShrink: 0 }}>
            <Label color={t.text} size={13} weight={600}>{['Accounts', 'Machines', 'Checks'][i]}</Label>
            <ProblemRow {...spec} {...buttons(spec, `row-${i}`)} testId={`row-${i}`} />
          </div>
        ))}
      </div>
      <div testId="pressed" style={{ position: 'absolute', left: 24, top: 790 }}><Label color={t.textTertiary} size={11}>{pressed}</Label></div>
      <Toaster />
    </div>
  )
}

export const sections: Record<string, ComponentType> = { problem: Problems }
