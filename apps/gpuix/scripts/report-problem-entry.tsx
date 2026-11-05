// The window `report-problem-check.ts` drives: a failed page (`ProblemState` from a real `describeProblem` view) whose details carry text a
// report must strip (the machine's own user name in a path, an e-mail address, a token), and the app's dialog layer that shows the review sheet.
import '../src/native/local-build.ts'
import { render, useGpuixRequired } from '@gpuix/react'
import { userInfo } from 'node:os'
import { useEffect, useState, type ReactNode } from 'react'
import { RpcCallError } from '../../../packages/kybern-client/src/client.ts'
import { describeProblem } from '../../../packages/kybern-client/src/problems.ts'
import { WorkspaceDialogs } from '../src/dialogs/Dialogs.tsx'
import { ProblemState } from '../src/kit/Problem.tsx'
import { installFrameSource } from '../src/native/frame.ts'
import { problemProps } from '../src/problems/props.ts'
import { ThemeProvider, useTheme } from '../src/ui.tsx'

function Ready({ children }: { children: ReactNode }) {
  const renderer = useGpuixRequired()
  const [ready, setReady] = useState(false)
  useEffect(() => { installFrameSource(renderer); setReady(true) }, [renderer])
  return ready ? children : null
}

const user = userInfo().username
const detail = [
  `github.pr.list: run gh: C:\\Users\\${user}\\scoop\\shims\\gh.exe exited with status 1`,
  `  cwd /Users/${user}/projects/kybern`,
  `  git config user.email = ${user}@example.com`,
  `  GH_TOKEN=ghp_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'}`,
].join('\n')
const error = new RpcCallError({ code: -32603, message: detail, data: { problem: { kind: 'internal', detail, retryable: true } } })
const view = describeProblem(error, { action: 'load pull requests' })

function Frame() {
  const t = useTheme()
  return (
    <div testId="app-ready" style={{ width: 960, height: 720, position: 'relative', overflow: 'hidden', backgroundColor: t.v('--background'), display: 'flex' }}>
      <ProblemState {...problemProps(view, { retry: () => {} }, 'state')} />
      <WorkspaceDialogs />
    </div>
  )
}

render(<ThemeProvider><Ready><Frame /></Ready></ThemeProvider>, { title: 'report a problem', width: 960, height: 720, windowBackground: 'opaque', focus: process.env.GPUIX_BACKGROUND !== '1' })
