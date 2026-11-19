// Standalone native fixture for #309: the idle-compaction notice's "Change in Settings" opening the real Settings page on
// Agent providers at the Compaction section. No daemon connection. `LANDING_OPTIONAL=1` adds what may sit above
// Compaction (a project, so OMP profiles gets its "Project overrides" row, and a fifth agent with its own threshold).
// Run through @gpuix/react/automation with GPUIX_BACKGROUND=1 (`scripts/settings-scroll-check.ts`).
import '../native/local-build.ts'
import { render } from '@gpuix/react'
import type { IdleCompactionBlock } from '../../../../packages/kybern-client/src/transcript.ts'
import type { Project, ProviderStatus, Settings } from '../../../../packages/kybern-client/src/types.ts'
import { onWindowKeyDown } from '../nav/keys.ts'
import { setNav, useNav } from '../nav/store.ts'
import { setWindowWidth } from '../shell/layout.ts'
import { set } from '../state.ts'
import { IdleCompactionRow } from '../transcript/IdleCompaction.tsx'
import { ThemeProvider, useTheme } from '../ui.tsx'
import { SettingsScreen } from './SettingsScreen.tsx'
import { setSettings } from './store.ts'

const optional = process.env.LANDING_OPTIONAL === '1'
const provider = (kind: string, display_name: string) => ({ kind, display_name, available: true, binary_path: `/usr/local/bin/${kind}`, version: '1.0.0', models: [], supported_permission_modes: ['supervised'], instances: ['default'] }) as unknown as ProviderStatus
const providers = [provider('claude-code', 'Claude Code'), provider('codex', 'Codex'), provider('opencode', 'OpenCode'), ...(optional ? [provider('omp', 'Oh My Pi')] : [])]
const settings = JSON.parse(process.env.LANDING_SETTINGS!) as Settings
const project = { id: 'proj', name: 'lumen-web', path: '/fixture/lumen-web', is_git: true } as Project
const block: IdleCompactionBlock = { kind: 'idle_compaction', id: 'idle-compaction:turn2', turnId: 'turn2', at: '2026-11-08T14:38:00Z', seq: 20, contextTokens: 312_000, contextAfter: 38_000, cacheExpiresAt: '2026-11-08T14:40:00Z', cacheTtlSeconds: 3600, finishedAt: '2026-11-08T14:38:20Z', failed: false }

setNav({ providers })
setSettings(settings)
set({ projects: optional ? [project] : [] })

function Fixture() {
  const t = useTheme()
  const open = useNav((s) => s.settingsOpen)
  return (
    <div testId="landing-ready" style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', backgroundColor: t.surface }}>
      {open ? <SettingsScreen /> : <div style={{ display: 'flex', flexDirection: 'column', padding: 40, width: 720 }}><IdleCompactionRow block={block} /></div>}
    </div>
  )
}

setWindowWidth(1200)
render(<ThemeProvider><Fixture /></ThemeProvider>, { title: 'Settings landing', width: 1200, height: 820, focus: false, onKeyDown: onWindowKeyDown })
process.stdin.on('end', () => process.exit(0))
process.stdin.on('close', () => process.exit(0))
