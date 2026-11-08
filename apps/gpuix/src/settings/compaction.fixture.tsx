// Standalone native verification of the compaction UI (issue #295): no daemon connection, no production data.
//   COMPACTION_MODE=settings    Settings → Agent providers → Compaction, and an account's ⋯ menu
//   COMPACTION_MODE=transcript  a thread with an idle compaction notice, and the composer's prompt-cache popover
// Run through @gpuix/react/automation with GPUIX_BACKGROUND=1 (`compaction.verify.ts`).
import '../native/local-build.ts'
import { render } from '@gpuix/react'
import { emptyThreadState, type Block } from '../../../../packages/kybern-client/src/transcript.ts'
import type { Project, ProviderStatus, Settings, Thread } from '../../../../packages/kybern-client/src/types.ts'
import { ComposerView } from '../Composer.tsx'
import { patch } from '../composer/store.ts'
import { Menu } from '../nav/overlay.tsx'
import { onWindowKeyDown } from '../nav/keys.ts'
import { setNav } from '../nav/store.ts'
import { setWindowWidth } from '../shell/layout.ts'
import { set } from '../state.ts'
import { Transcript } from '../Transcript.tsx'
import { Button } from '../kit/Button.tsx'
import { ThemeProvider, useTheme } from '../ui.tsx'
import { AccountIdleCompaction, CompactionSection } from './Compaction.tsx'
import { PageBlock } from './controls.tsx'
import { setSettings } from './store.ts'

const mode = process.env.COMPACTION_MODE ?? 'settings'
const minutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString()
const old = '2026-11-08T13:40:00Z'

const provider = (kind: string, display_name: string) => ({ kind, display_name, available: true, models: [], supported_permission_modes: ['supervised'] }) as unknown as ProviderStatus
const providers = [provider('claude-code', 'Claude Code'), provider('codex', 'Codex'), provider('opencode', 'OpenCode'), provider('omp', 'Oh My Pi'), provider('cursor', 'Cursor')]
const settings = {
  default_provider: 'claude-code', default_permission_mode: 'supervised', worktrees_default: false, generate_titles: true, notifications: true,
  auto_update_harnesses: false, auto_update_daemon: false, background: {}, access: {}, computer_use: {}, orchestration: {}, tell_agents_about_kybern: true,
  providers: { 'claude-code': { env: {}, idle_compaction: { work: 'never' } } },
  compaction: { idle: 'before_cache_expires', auto_compact_tokens: { 'claude-code': 400_000 } },
} as unknown as Settings

setNav({ providers })
setSettings(settings)
patch({ settings })

function SettingsPage() {
  const t = useTheme()
  return (
    <div testId="compaction-ready" style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', backgroundColor: t.surface, padding: 24, gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', width: 680 }}>
        <Menu testId="account-menu" align="end" minWidth={192} trigger={() => <Button testId="account-menu-open">Work account ⋯</Button>}>
          <AccountIdleCompaction kind="claude-code" instance="work" testId="account-idle" />
        </Menu>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', width: 680 }}>
        <PageBlock><CompactionSection /></PageBlock>
      </div>
    </div>
  )
}

const thread = { id: 'thread', title: 'Parser refactor', project_id: 'proj', provider: { kind: 'claude-code', instance: 'default' }, status: 'idle', permission_mode: 'supervised', created_at: old, updated_at: old } as Thread
const project = { id: 'proj', name: 'lumen-web', path: '/tmp/lumen-web', is_git: true, brief_in_all_threads: false } as Project
const blocks: Block[] = [
  { kind: 'user', id: 'u1', turnId: 'turn1', at: old, seq: 10, message: { parts: [{ type: 'text', text: 'Split the parser into a tokenizer and a tree builder, and keep the error positions exact.' }] } },
  { kind: 'assistant', id: 'a1', messageId: 'a1', segment: 0, turnId: 'turn1', at: old, seq: 11, origin: { kind: 'root' }, text: 'Done. `src/parse/tokenize.ts` produces tokens with byte offsets; `src/parse/tree.ts` builds the tree and reports errors at the token that failed. All 214 parser tests pass.', thinking: '', complete: true },
  { kind: 'turn_end', id: 'end1', turnId: 'turn1', at: old, seq: 12, stopReason: 'completed', usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }, costUsd: null, durationMs: 412_000, terminalMessageId: 'a1', error: null },
  { kind: 'idle_compaction', id: 'idle-compaction:turn2', turnId: 'turn2', at: '2026-11-08T14:38:00Z', seq: 20, contextTokens: 312_000, contextAfter: 38_000, cacheExpiresAt: '2026-11-08T14:40:00Z', cacheTtlSeconds: 3600, finishedAt: '2026-11-08T14:38:20Z', failed: false },
  { kind: 'turn_end', id: 'end2', turnId: 'turn2', at: '2026-11-08T14:38:20Z', seq: 21, stopReason: 'completed', usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }, costUsd: null, durationMs: 20_000, terminalMessageId: null, error: null },
  { kind: 'user', id: 'u3', turnId: 'turn3', at: minutes(-8), seq: 30, message: { parts: [{ type: 'text', text: 'Now add a test for unterminated strings.' }] } },
  { kind: 'assistant', id: 'a3', messageId: 'a3', segment: 0, turnId: 'turn3', at: minutes(-8), seq: 31, origin: { kind: 'root' }, text: 'Added `unterminated string` to `tokenize.test.ts`; it reports the opening quote’s offset.', thinking: '', complete: true },
  { kind: 'turn_end', id: 'end3', turnId: 'turn3', at: minutes(-8), seq: 32, stopReason: 'completed', usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }, costUsd: null, durationMs: 31_000, terminalMessageId: 'a3', error: null },
  { kind: 'user', id: 'u4', turnId: 'turn4', at: minutes(-1), seq: 40, message: { parts: [{ type: 'text', text: '/compact' }] } },
]
const running: Block[] = [...blocks.slice(0, -1), { kind: 'idle_compaction', id: 'idle-compaction:turn4', turnId: 'turn4', at: minutes(0), seq: 41, contextTokens: 241_000, contextAfter: null, cacheExpiresAt: minutes(2), cacheTtlSeconds: 3600, finishedAt: null, failed: false }]
const usage = { context: { used_tokens: 241_000, window_tokens: 1_000_000 }, prompt_cache: { ttl_seconds: 3600, expires_at: minutes(52), estimated: false } }

function Chat() {
  const t = useTheme()
  return (
    <div testId="compaction-ready" style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', backgroundColor: t.surface }}>
      <div style={{ display: 'flex', gap: 8, padding: 12 }}>
        <Button testId="compaction-running" onClick={() => set({ open: { ...emptyThreadState(), loaded: true, thread, blocks: running, providerUsage: usage } })}>Show a running compaction</Button>
      </div>
      <Transcript />
      <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}>
        <ComposerView draftKey="compaction" currentThreadId={thread.id} provider={{ kind: 'claude-code', instance: 'default' }} providers={[providers[0]!]} accounts={[]} model="Opus 5.5" effort="high" mode="supervised" onModeChange={() => {}} catalogLoading={false} onReloadModels={async () => {}} running={false} canSteer onSend={async () => {}} />
      </div>
    </div>
  )
}

setWindowWidth(mode === 'settings' ? 760 : 1000)
if (mode !== 'settings') set({ status: 'open', threads: [thread], projects: [project], selectedId: thread.id, open: { ...emptyThreadState(), loaded: true, thread, blocks: blocks.slice(0, -1), providerUsage: usage } })
render(<ThemeProvider>{mode === 'settings' ? <SettingsPage /> : <Chat />}</ThemeProvider>, { title: 'Compaction verification', width: mode === 'settings' ? 760 : 1000, height: 860, focus: false, onKeyDown: onWindowKeyDown })
process.stdin.on('end', () => process.exit(0))
process.stdin.on('close', () => process.exit(0))
