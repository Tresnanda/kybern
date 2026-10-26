// The Coordinator's notes-as-history UI on a deterministic native fixture: the Notes dock (categories, stale and undated rows), the
// note editor (category picker, "May be outdated" banner, a retired claim), the dock's Map tab, the "Tidy notes" card, the
// note-changes proposal card and the "Tidy notes" transcript row. A fake daemon answers over a socket; every call it receives is
// appended to `<KYBERN_DATA_DIR>/calls.log` for `knowledge.verify.ts`. Nothing reaches a real daemon.
import '../native/local-build.ts'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { render } from '@gpuix/react'
import { useState } from 'react'
import { COORDINATOR_NOTES_TOOL, PROTOCOL_VERSION, type ApprovalRequest, type NoteSummary, type ProjectMap, type ProviderStatus, type Thread } from '../../../../packages/kybern-client/src/types.ts'
import { emptyThreadState } from '../../../../packages/kybern-client/src/transcript.ts'
import { connect, set, useApp } from '../state.ts'
import { Composer } from '../Composer.tsx'
import { Dock } from '../dock/Dock.tsx'
import { setDock, type DockTab } from '../dock/store.ts'
import { NoteEditor } from '../notes/NoteEditor.tsx'
import { refreshNotes } from '../notes/store.ts'
import { ThreadRequests } from '../transcript/Requests.tsx'
import { UserBubble } from '../transcript/bubble.tsx'
import { Button } from '../kit/Button.tsx'
import { onWindowKeyDown } from '../nav/keys.ts'
import { patch } from '../composer/store.ts'
import { setWindowWidth } from '../shell/layout.ts'
import { ThemeProvider, Label, useTheme } from '../ui.tsx'

const at = '2026-10-26T09:00:00Z'
const dir = process.env.KYBERN_DATA_DIR
if (!dir) throw Error('Fixture requires an isolated data directory')
const log = (entry: unknown) => appendFileSync(path.join(dir, 'calls.log'), `${JSON.stringify(entry)}\n`)

const project = { id: 'fixture', name: 'lumen-web', path: '/tmp/fixture', is_git: true, brief_in_all_threads: false, created_at: at, updated_at: at }
const thread = { id: 'coordinator', title: 'Project coordinator', project_id: 'fixture', coordinator_project_id: 'fixture', provider: { kind: 'claude-code', instance: 'default' }, model: 'claude-opus-5-5', status: 'idle', permission_mode: 'supervised', cwd: '/tmp/fixture', created_at: at, updated_at: at, pinned: false, last_seq: 0 } as unknown as Thread
const providers = ['claude-code', 'codex'].map((kind) => ({ kind, display_name: kind, available: true, supported_permission_modes: ['supervised'], supports_fork: false, supports_model_switch: true, instances: [], models: [] }) as unknown as ProviderStatus)

const note = (id: string, title: string, preview: string, extra: Partial<NoteSummary> = {}): NoteSummary => ({ id, scope: 'project', project_id: 'fixture', title, preview, checklist: { done: 0, total: 0 }, pinned: false, revision: 1, created_at: '2026-10-20T10:00:00Z', updated_at: '2026-10-20T10:00:00Z', ...extra })
const NOTES: NoteSummary[] = [
  note('n-pref', 'Onboarding copy', '“Don’t touch the onboarding copy without asking me.”', { category: 'preference', updated_at: '2026-10-20T10:00:00Z' }),
  note('n-auth', 'Expired login handling', 'Expired sessions redirect to /sign-in.', { category: 'decision', updated_at: '2026-10-26T08:30:00Z', stale: { path: 'src/auth/session.ts', commit: 'f19b20c' } }),
  note('n-sess', 'Session storage', 'As of a41c9e2: sessions stay server-side…', { category: 'decision', updated_at: '2026-10-24T10:00:00Z' }),
  note('n-rls', 'Supabase RLS on profiles', 'As of 7c0de11: profiles policies check the owner.', { category: 'gotcha', updated_at: '2026-10-22T10:00:00Z', stale: { path: 'supabase/migrations/20261021_profiles.sql', commit: '3be9a47' } }),
  note('n-lovable', 'Lovable export notes', 'What the export left behind, mostly dead code.', { undated: true, updated_at: '2026-10-12T10:00:00Z' }),
  note('n-misc', 'Release checklist', 'Tag, changelog, then the store listing.', { updated_at: '2026-10-18T10:00:00Z' }),
]
let notes = NOTES
const AUTH_BODY = [
  '- ~~2026-10-21 · As of `a41c9e2`: expired sessions fall back to `/pre-launch` (`src/auth/session.ts`).~~ (superseded 2026-10-25)',
  '- 2026-10-25 · As of `def5678`: removed the pre-launch fallback, a Lovable leftover that caused the Oct 24 bug. Expired sessions redirect to `/sign-in` (`src/auth/session.ts`). Thread “Remove legacy auth fallback”.',
  '- 2026-10-25 · Alex: “Never send people to pre-launch again, it’s dead.”',
  '',
].join('\n')
const MAP: ProjectMap = {
  built_at: new Date(Date.now() - 2 * 60_000).toISOString(),
  repos: [{ path: '.', name: 'lumen-web', default_branch: 'main', branch: 'main', head: 'def5678abc1234567890abc1234567890abcdef0', files: 412 }],
  layout: [
    { repo: '.', path: 'src/app', files: 48, name: 'Next.js routes' },
    { repo: '.', path: 'src/auth', files: 9, name: 'Sessions and sign-in' },
    { repo: '.', path: 'src/components', files: 61, name: 'UI components' },
    { repo: '.', path: 'supabase/migrations', files: 23, name: 'Migrations' },
  ],
  commands: [
    { repo: '.', source: 'package.json', name: 'pnpm dev', run: 'next dev' },
    { repo: '.', source: 'package.json', name: 'pnpm test', run: 'vitest run' },
    { repo: '.', source: 'package.json', name: 'pnpm build', run: 'next build' },
    { repo: '.', source: 'README.md', name: 'supabase db push', run: 'Deploy' },
  ],
  busy: [{ repo: '.', path: 'src/auth', commits: 14 }, { repo: '.', path: 'src/app/(marketing)', commits: 9 }, { repo: '.', path: 'supabase/migrations', commits: 6 }, { repo: '.', path: 'src/components/ui', commits: 4 }],
  removed: [
    { repo: '.', kind: 'deleted', path: 'src/auth/prelaunch.ts', commit: 'def5678abc1234', date: '2026-10-25T10:12:00Z', subject: 'Remove the pre-launch fallback' },
    { repo: '.', kind: 'renamed', path: 'supabase/client.ts', from: 'src/lib/supabase.ts', commit: '9a31c7e55d1000', date: '2026-10-22T16:40:00Z', subject: 'Move the Supabase client' },
  ],
  header: 'Map as of lumen-web@def5678',
}
let mode = 'notes', offer = true, responded = ''
const tidy = () => ({ stale: ['n-auth', 'n-rls', 'a', 'b', 'c'], offer, ...(offer ? {} : { snoozed_until: '2026-11-02T09:00:00Z' }) })
const proposal = (): ApprovalRequest => ({
  id: 'proposal', thread_id: 'coordinator', turn_id: 'turn', tool_call_id: 'call', created_at: at, suggestions: [], summary: 'Apply 3 note changes?', tool_name: COORDINATOR_NOTES_TOOL,
  input: { reason: 'The pre-launch fallback is gone and three notes still describe it.', changes: [
    { path: '0', note_id: 'n-auth', note_title: 'Expired login handling', op: 'supersede', text: '- 2026-10-26 · As of `f19b20c`: expired sessions redirect to `/sign-in` and keep the requested page (`src/auth/session.ts`).', supersedes: 'expired sessions fall back to `/pre-launch`', category: 'decision' },
    { path: '1', note_id: 'n-rls', note_title: 'Supabase RLS on profiles', op: 'append', text: '- 2026-10-26 · As of `3be9a47`: profile policies check `auth.uid()` (`supabase/migrations/20261021_profiles.sql`).', category: 'gotcha' },
    { path: '2', note_id: 'n-sess', note_title: 'Session storage', op: 'append', text: '- 2026-10-26 · As of `f19b20c`: the session cookie is HttpOnly and lasts 14 days (`src/auth/session.ts`).', category: 'decision' },
  ] },
} as unknown as ApprovalRequest)

const sockets = new Set<{ send(data: string): void }>()
const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(req, s) { if (s.upgrade(req)) return; return new Response('fixture') }, websocket: { open(ws) { sockets.add(ws) }, close(ws) { sockets.delete(ws) }, message(ws, raw) {
  const { id, method, params: p = {} } = JSON.parse(String(raw)); let result: unknown = {}
  switch (method) {
    case 'daemon.info': result = { protocol_version: PROTOCOL_VERSION, environment_id: 'knowledge-fixture', version: 'fixture' }; break
    case 'projects.list': result = { projects: [project] }; break
    case 'threads.list': result = { threads: [thread] }; break
    case 'threads.messages.list': result = { messages: [] }; break
    case 'tasks.list': result = { tasks: [] }; break
    case 'tasks.items.list': result = { tasks: [] }; break
    case 'events.subscribe': result = { subscription_id: 'fixture', head_seq: 0, replay_ready: true }; break
    case 'providers.list': result = { providers }; break
    case 'providers.accounts.list': result = { accounts: [] }; break
    case 'providers.accounts.catalog': result = providers.find((v) => v.kind === p.provider?.kind); break
    case 'settings.get': result = { providers: {}, default_provider: 'claude-code', default_permission_mode: 'supervised' }; break
    case 'queue.list': result = { messages: [] }; break
    case 'threads.target.get': result = { target: { provider: thread.provider, model: thread.model }, pending_permission_mode: null, quota_limited: false }; break
    case 'subagents.messages': result = []; break
    case 'requests.progress': result = { items: [] }; break
    case 'skills.list': result = { skills: [] }; break
    case 'notes.list': result = { notes, history_since: '2026-10-25T00:00:00Z' }; break
    case 'notes.get': { const found = notes.find((n) => n.id === p.id); result = { note: found ? { ...found, body: found.id === 'n-auth' ? AUTH_BODY : `${found.preview}\n` } : null }; break }
    case 'notes.update': { notes = notes.map((n) => n.id === p.id ? { ...n, ...(p.category ? { category: p.category } : {}) } : n); result = { ...notes.find((n) => n.id === p.id), body: p.id === 'n-auth' ? AUTH_BODY : '' }; break }
    case 'projects.map': result = { project_id: 'fixture', map: { ...MAP, built_at: new Date().toISOString() } }; break
    case 'notes.tidy_offer': result = tidy(); break
    case 'notes.tidy_snooze': offer = false; result = tidy(); break
    case 'notes.tidy_start': offer = false; result = { thread_id: 'coordinator', notes: 5 }; break
    case 'approvals.respond': responded = JSON.stringify(p.response ?? p.decision); set({ open: { ...emptyThreadState(), thread, loaded: true, pendingApprovals: [] } }); break
  }
  if (method !== 'events.subscribe' && !/^(providers|settings|queue|skills|subagents|requests|threads\.(messages|target)|tasks)\./.test(method)) log({ method, params: p })
  ws.send(JSON.stringify({ jsonrpc: '2.0', id, result }))
  set({ statusDetail: `${method}:${Date.now()}` })
} } })
mkdirSync(dir, { recursive: true })
writeFileSync(path.join(dir, 'daemon.port'), String(server.port))
writeFileSync(path.join(dir, 'daemon.token'), 'fixture', { mode: 0o600 })
process.env.KYBERN_URL = `ws://127.0.0.1:${server.port}/ws`
process.env.KYBERN_TOKEN = 'fixture'
patch({ providers })
// The shell's poller reports the window width; the dock sizes itself from it.
setWindowWidth(1280)
connect()

const DOCK_MODES: Record<string, DockTab> = { notes: 'notes', map: 'map' }
function show(next: string) {
  mode = next; offer = next === 'tidy'; responded = ''
  notes = NOTES
  set({ selectedId: thread.id, open: { ...emptyThreadState(), thread, loaded: true, pendingApprovals: next === 'proposal' ? [proposal()] : [] } })
  const tab = DOCK_MODES[next]
  setDock(thread.id, { open: !!tab, tabs: ['agents', 'project', 'map', 'notes', 'tasks'], tab: tab ?? 'agents', instant: true })
  // The daemon says notes changed, so the notes list and the tidy offer read again.
  for (const socket of sockets) socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'notes.changed', params: {} }))
  void refreshNotes()
}
show(mode)

const MODES = ['notes', 'map', 'editor', 'tidy', 'proposal', 'row']
function Fixture() {
  const t = useTheme()
  const [selected, choose] = useState(mode)
  useApp((s) => s.statusDetail)
  return <div testId="fixture-ready" style={{ display: 'flex', flexDirection: 'row', width: '100%', height: '100%', backgroundColor: t.surface }}>
    <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: 14 }}>{MODES.map((name) => <Button key={name} size="sm" testId={`fixture-${name}`} variant={selected === name ? 'secondary' : 'ghost'} onClick={() => { choose(name); show(name) }}>{name}</Button>)}</div>
      {responded && <div testId="responded" aria-label={responded} style={{ width: 1, height: 1 }} />}
      {selected === 'editor' ? <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0 }}><NoteEditor id="n-auth" width={900} /></div>
        : selected === 'row' ? <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, alignItems: 'center', paddingTop: 40 }}><div style={{ display: 'flex', flexDirection: 'column', width: 640, gap: 20 }}>
          <UserBubble parts={[{ type: 'system_row', kind: 'coordinator_tidy_notes', text: 'Tidy notes' }]} at={at} />
          <Label color={t.text} size={14} lineHeight={22}>I’ll check the five flagged notes against the current code and propose the changes.</Label>
        </div></div>
        : <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0 }}>
          <div style={{ flexGrow: 1 }} />
          <div style={{ display: 'flex', flexDirection: 'column', width: '100%', maxWidth: 720, alignSelf: 'center', paddingBottom: 18 }}><ThreadRequests /><Composer thread={thread} /></div>
        </div>}
    </div>
    {selected === 'notes' || selected === 'map' ? <Dock sidebarOpen={false} /> : null}
  </div>
}
render(<ThemeProvider><Fixture /></ThemeProvider>, { title: 'Coordinator knowledge', width: 1280, height: 820, focus: false, onKeyDown: onWindowKeyDown })
process.stdin.on('end', () => { server.stop(true); process.exit(0) })
process.stdin.on('close', () => { server.stop(true); process.exit(0) })
