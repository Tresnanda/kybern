// The real components behind #232 families 4-5 (terminal, files, worktree, settings, notes, tasks, SSH) on synthetic errors, in one 1280 x 820
// window, so `scripts/errors-p3b-check.ts` can assert what is painted and capture it in light and dark.
// Retry buttons record what was pressed instead of running anything.
import '../src/native/local-build.ts'
import { render, useGpuixRequired } from '@gpuix/react'
import { useEffect, useState, type ReactNode } from 'react'
import { OfflineError } from '../../../packages/kybern-client/src/machineClient.ts'
import { ErrorLine } from '../src/dock/parts.tsx'
import { WorktreeProblem } from '../src/dialogs/WorktreeCleanup.tsx'
import { AddMachineProblem, SshProblem } from '../src/environments/Dialogs.tsx'
import { installFrameSource } from '../src/native/frame.ts'
import { ProblemLine } from '../src/problems/Line.tsx'
import { toast, Toaster } from '../src/shell/toasts.tsx'
import { cliRefusedCopy } from '../src/settings/cliProblem.ts'
import { Label, ThemeProvider, useTheme } from '../src/ui.tsx'

function Ready({ children }: { children: ReactNode }) {
  const renderer = useGpuixRequired()
  const [ready, setReady] = useState(false)
  useEffect(() => { installFrameSource(renderer); setReady(true) }, [renderer])
  return ready ? children : null
}

const Heading = ({ children }: { children: string }) => { const t = useTheme(); return <Label color={t.textSecondary} size={11} weight={600}>{children}</Label> }
const column = { display: 'flex', flexDirection: 'column', gap: 6, width: 400, padding: 16, flexShrink: 0 } as const

function Panels() {
  const t = useTheme()
  const [pressed, setPressed] = useState('none')
  const press = (id: string) => () => setPressed(id)
  useEffect(() => {
    const refused = cliRefusedCopy('install', 'Unable to link C:\\Users\\Bagus\\.local\\bin\\kybern: EPERM: operation not permitted, symlink')!
    toast.problem(refused.title, { id: 'cli', tone: 'warning', icon: 'lock', duration: Infinity, description: refused.body, secondary: { label: 'Copy', onClick: press('cli-copy') } })
    return () => { toast.dismiss('cli') }
  }, [])
  const eperm = new Error("EPERM: operation not permitted, open 'C:\\Users\\Bagus\\projects\\kybern\\src\\main.ts'")
  const lock = new Error('failed to remove D:\\work\\wt: The process cannot access the file because it is being used by another process (Code.exe) (os error 32)')
  return (
    <div style={{ position: 'relative', width: 1280, height: 820, display: 'flex' }}>
      <div style={column}>
        <Heading>Terminal</Heading>
        <ErrorLine error={new OfflineError('', false)} action="keep the terminal running" machine="SatyaMas" testId="terminal-problem" />
        <Heading>File editor</Heading>
        <ErrorLine error={eperm} action="save main.ts" retry={press('save-retry')} testId="file-problem" />
        <Heading>Artifacts</Heading>
        <ErrorLine error={new Error('exit status 1')} action="load the artifacts" retry={press('artifacts-retry')} testId="artifacts-problem" />
      </div>
      <div style={column}>
        <Heading>Remove worktree</Heading>
        <WorktreeProblem error={lock} action="remove the worktree" retry={press('worktree-retry')} />
        <Heading>Add a machine over SSH</Heading>
        <SshProblem error={new Error('ssh: kybern@192.168.1.20: Permission denied (publickey).')} target="kybern@192.168.1.20" showKeyCommand />
        <Heading>Add a machine by address</Heading>
        <AddMachineProblem error={new Error('error sending request for url (http://192.168.1.20:4199/)')} loopback={false} retry={press('machine-retry')} />
      </div>
      <div style={column}>
        <Heading>Settings, About, notes</Heading>
        <ProblemLine error={new OfflineError('', false)} action="read this machine's details" retry={press('about-retry')} testId="about-problem" />
        <ProblemLine error={new Error('RpcCallError: not found: note')} action="open this note" retry={press('note-retry')} testId="note-problem" />
        <ProblemLine error={new Error('invalid params: title')} action="add the task" testId="task-problem" />
      </div>
      <div testId="pressed" style={{ position: 'absolute', left: 16, top: 796 }}><Label color={t.textTertiary} size={11}>{pressed}</Label></div>
      <Toaster />
    </div>
  )
}

function Frame() {
  const t = useTheme()
  return <div testId="app-ready" style={{ width: 1280, height: 820, position: 'relative', overflow: 'hidden', backgroundColor: t.v('--background') }}><Panels /></div>
}

render(<ThemeProvider><Ready><Frame /></Ready></ThemeProvider>, { title: 'errors p3b', width: 1280, height: 820, windowBackground: 'opaque', focus: process.env.GPUIX_BACKGROUND !== '1' })
