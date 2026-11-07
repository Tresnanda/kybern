// Production Coordinator settings section with scratch sample data; no daemon connection.
import '../native/local-build.ts'
import { render } from '@gpuix/react'
import { useState } from 'react'
import { ThemeProvider, useTheme } from '../ui.tsx'
import { CoordinatorMcpToolsView } from './primary.tsx'
import type { ProviderKind } from '../../../../packages/kybern-client/src/types.ts'

function Fixture() {
  const t = useTheme()
  const [allowed, setAllowed] = useState<Partial<Record<ProviderKind, string[]>>>({})
  return <div testId="coordinator-mcp-ready" style={{ width: '100%', height: '100%', backgroundColor: t.surface, paddingTop: 30 }}>
    <CoordinatorMcpToolsView servers={{ omp: ['codebase-memory', 'github'] }} allowed={allowed} saving={false} onChange={(provider, name, checked) => setAllowed((current) => ({ ...current, [provider]: checked ? [...(current[provider] ?? []), name] : (current[provider] ?? []).filter((server) => server !== name) }))} />
  </div>
}
render(<ThemeProvider><Fixture /></ThemeProvider>, { title: 'Coordinator tools', width: 760, height: 320, focus: false })
process.stdin.on('end', () => process.exit(0))
