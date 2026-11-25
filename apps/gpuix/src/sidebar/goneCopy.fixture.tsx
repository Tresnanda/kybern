// Native-only fixture for the sidebar's "Folder is gone on <machine>" line: no daemon or network.
import '../native/local-build.ts'
import { render } from '@gpuix/react'
import { ThemeProvider, useTheme, Label } from '../ui.tsx'
import { GoneCopyRow } from './rows.tsx'
import type { Project } from '../../../../packages/kybern-client/src/types.ts'

const project = { id: 'p', name: 'Group project', path: '/w/group', is_git: false, brief_in_all_threads: false, kind: 'group', members: [] } as unknown as Project

function Fixture() {
  const t = useTheme()
  return (
    <div testId="gone-copy-fixture-ready" style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', backgroundColor: t.surface, paddingTop: 12 }}>
      <div style={{ display: 'flex', flexDirection: 'column', width: 280 }}>
        <div style={{ height: 28, paddingLeft: 14, display: 'flex', alignItems: 'center' }}><Label color={t.text}>Group project</Label></div>
        <GoneCopyRow project={project} copy={{ machineId: 'build-server', projectId: 'p-remote' }} />
        <div style={{ height: 28, paddingLeft: 38, display: 'flex', alignItems: 'center' }}><Label color={t.textSecondary}>Create coordinator</Label></div>
      </div>
    </div>
  )
}
render(<ThemeProvider><Fixture /></ThemeProvider>, { title: 'Gone copy fixture', width: 320, height: 260, focus: false })
process.stdin.on('end', () => process.exit(0))
process.stdin.on('close', () => process.exit(0))
