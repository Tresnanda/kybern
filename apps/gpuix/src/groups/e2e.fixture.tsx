// The real app against a real scratch daemon (every group RPC served by the daemon itself), for `e2e.verify.ts`. Only the
// native folder panel is replaced: the next folder it returns is read from `<E2E_SCRATCH>/next-pick.txt`.
//
//   E2E_SCRATCH=<…gpuix-scratch…> KYBERN_DATA_DIR=<…gpuix-scratch…/data> bun src/groups/e2e.fixture.tsx   (or through `e2e.drive.ts`)
import '../native/local-build.ts'
import { render, useGpuixRequired } from '@gpuix/react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { useEffect, useState } from 'react'
import { App } from '../App.tsx'
import { onWindowKeyDown } from '../nav/keys.ts'
import { connect } from '../state.ts'
import { startWindowShell } from '../shell/window.ts'
import { ThemeProvider } from '../ui.tsx'

const root = process.env.E2E_SCRATCH ?? ''
if (!root.includes('gpuix-scratch') || !process.env.KYBERN_DATA_DIR?.includes('gpuix-scratch')) throw Error('The e2e fixture requires scratch paths')

connect()
function Fixture() {
  const renderer = useGpuixRequired()
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const original = renderer.promptForPaths
    renderer.promptForPaths = async () => {
      try { return [readFileSync(path.join(root, 'next-pick.txt'), 'utf8').trim()] } catch { return null }
    }
    // The dock and split panes size from the shell's window-width subscription.
    startWindowShell(renderer)
    setReady(true)
    return () => { renderer.promptForPaths = original }
  }, [renderer])
  return <div style={{ display: 'flex', width: '100%', height: '100%' }}>{ready && <App />}</div>
}
render(<ThemeProvider><Fixture /></ThemeProvider>, { title: 'Kybern e2e', width: 1280, height: 820, focus: false, onKeyDown: onWindowKeyDown })
process.stdin.on('end', () => process.exit(0))
