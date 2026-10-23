// The question card's states (ADE-69..71 spec, `.kybern-artifacts/ade-69-71/qcard/`) on a deterministic native fixture: no
// connection or writes to any real daemon. `qcard.shots.ts` drives it; `QCARD_WIDTH` is the column of the wide modes (700, so A),
// `QCARD_NARROW` that of the `b-` modes (440).
import '../native/local-build.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { render, useGpuixRequired } from '@gpuix/react'
import { useState } from 'react'
import { PROTOCOL_VERSION, type ApprovalRequest, type Thread } from '../../../../packages/kybern-client/src/types.ts'
import { emptyThreadState } from '../../../../packages/kybern-client/src/transcript.ts'
import { connect, set, useApp } from '../state.ts'
import { ThemeProvider, useTheme, Label } from '../ui.tsx'
import { Button } from '../kit/Button.tsx'
import { ThreadRequests } from '../transcript/Requests.tsx'
import { onWindowKeyDown } from '../nav/keys.ts'
import { focusCard } from './ui.ts'

const WALLPAPER = process.env.FIXTURE_WALLPAPER
const at = '2026-10-24T06:00:00Z'
let mode = 'arrival', sequence = 0, responded = ''
const thread = (): Thread => ({ id: `qcard-${sequence}`, title: 'Question card', project_id: 'fixture', provider: { kind: 'claude-code', instance: 'default' }, status: 'awaiting-approval', permission_mode: 'supervised', cwd: '/tmp/fixture', created_at: at, updated_at: at, pinned: false, last_seq: 0 } as Thread)
type Q = NonNullable<ApprovalRequest['questions']>[number]
const q = (question: string, options: { label: string; description?: string; preview?: string }[], extra: Partial<Q> = {}): Q => ({ id: question, question, options, multi_select: false, allow_custom: true, secret: false, attachments: true, ...extra })
const css = (body: string) => `\`\`\`css\n.settings {\n${body}\n}\n\`\`\``
const BRANCH = q('Which branch should the pull request target?', [{ label: 'main', description: 'The default branch. Merging here ships with the next release.' }, { label: 'release/0.14', description: 'Cut yesterday for v0.14.0. Only fixes land here.' }], { header: 'Branch' })
const LAYOUT = q('Which **layout** should the settings page use?\n\nWe render it at `1280×800`; pick the one that reads best.', [
  { label: 'Grid', description: 'Sidebar and content side by side', preview: css('  display: grid;\n  grid-template-columns: 240px 1fr;') },
  { label: 'Stack', description: 'One column', preview: css('  display: flex;\n  flex-direction: column;\n  gap: 16px;') },
], { header: 'Layout' })
const LONG = q(LAYOUT.question, [
  { label: 'Grid', description: 'Sidebar and content side by side', preview: css('  display: grid;\n  grid-template-columns: 240px minmax(0, 1fr);\n  gap: 24px;\n  max-width: 1120px;\n  margin-inline: auto;\n  padding: 32px;\n  align-items: start;\n  container-type: inline-size;') },
  { label: 'Stack', description: 'One column', preview: css('  display: flex;\n  flex-direction: column;') },
], { header: 'Layout' })
const NOTES = q('Which empty state should Notes show?', [
  { label: 'Short', description: 'One line about what Notes are for', preview: '**No notes yet**\n\nNotes keep what you and your agents learn in one place.' },
  { label: 'With a shortcut', description: 'Adds ⌘N and the agent hand-off', preview: '**No notes yet**\n\nPress ⌘N to write one, or ask an agent to save what it learns here.' },
], { header: 'Empty state' })
const CHECKS = q('Which checks should run before merge?', [{ label: 'Type check' }, { label: 'Unit tests' }, { label: 'Lint' }, { label: 'Visual snapshots', description: 'Adds about 4 minutes' }], { header: 'Checks', multi_select: true })
const SEVERAL = [
  q('Which layout should the settings page use?', [{ label: 'Grid' }, { label: 'Stack' }], { header: 'Layout' }),
  q('How dense should the settings rows be?', [{ label: 'Compact', description: '28 pt rows, more on screen' }, { label: 'Regular', description: '32 pt rows, the same as the sidebar' }], { header: 'Density' }),
  q('Where should Save sit?', [{ label: 'In the header' }, { label: 'At the bottom' }], { header: 'Save' }),
]
const TABS = q('Where should the tab strip sit?', [{ label: 'In the thread header', description: 'No extra height; it reads like the title bar.' }, { label: 'In a 32 px row', description: 'Room for more tabs below the header.' }], { header: 'Tabs' })
const FREE = q('What should the new space be called?', [], { header: 'Name' })

const request = (): ApprovalRequest => {
  const questions = mode.startsWith('a-') || mode.startsWith('b-') || mode === 'free-text' ? [mode.endsWith('clamp') ? LONG : mode.endsWith('markdown') ? NOTES : LAYOUT]
    : mode === 'multi' ? [CHECKS] : mode === 'middle' ? SEVERAL : mode === 'deadline' ? [TABS] : mode === 'free-only' ? [FREE] : [BRANCH]
  const now = Date.now()
  const input: Record<string, unknown> = { questions: questions.map((x) => ({ question: x.question, header: x.header, multiSelect: x.multi_select, options: x.options })) }
  if (mode === 'deadline') input.deadline = { ends_at: new Date(now + 581_000).toISOString(), started_at: new Date(now - 19_000).toISOString(), seconds: 600, defaults: { [TABS.question]: 'In a 32 px row' } }
  return { id: `q-${sequence}`, thread_id: thread().id, turn_id: 'turn', tool_call_id: 'call', created_at: at, suggestions: [], summary: questions[0]!.question, tool_name: 'AskUserQuestion', input, questions } as ApprovalRequest
}

const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(req, s) { if (s.upgrade(req)) return; return new Response('fixture') }, websocket: { message(ws, raw) {
  const message = JSON.parse(String(raw)); let result: unknown = {}; const params = message.params ?? {}
  switch (message.method) {
    case 'daemon.info': result = { protocol_version: PROTOCOL_VERSION, environment_id: 'qcard-fixture', version: 'fixture' }; break
    case 'projects.list': result = { projects: [] }; break
    case 'threads.list': result = { threads: [] }; break
    case 'threads.messages.list': result = { messages: [] }; break
    case 'tasks.list': result = { tasks: [] }; break
    case 'threads.target.get': result = { target: { provider: thread().provider }, pending_permission_mode: null, quota_limited: false }; break
    case 'subagents.messages': result = []; break
    case 'requests.progress': result = { items: [] }; break
    case 'events.subscribe': result = { subscription_id: 'fixture', head_seq: 0, replay_ready: true }; break
    case 'assets.upload': result = { asset_id: 'asset', name: params.name ?? 'image.png' }; break
    case 'approvals.respond': responded = JSON.stringify(params.response ?? params.decision); set({ statusDetail: responded }); break
  }
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
} } })
process.env.KYBERN_URL = `ws://127.0.0.1:${server.port}/ws`
process.env.KYBERN_TOKEN = 'fixture'
if (!process.env.KYBERN_DATA_DIR) throw Error('Fixture requires an isolated data directory')
mkdirSync(process.env.KYBERN_DATA_DIR, { recursive: true })
writeFileSync(path.join(process.env.KYBERN_DATA_DIR, 'daemon.port'), String(server.port))
writeFileSync(path.join(process.env.KYBERN_DATA_DIR, 'daemon.token'), 'fixture', { mode: 0o600 })
connect()
function show(next: string) {
  mode = next; sequence++; responded = ''
  set({ selectedId: thread().id, open: { ...emptyThreadState(), thread: thread(), loaded: true, pendingApprovals: [request()] } })
  // As on arrival, the card holds keyboard focus (the mode button would otherwise keep it).
  setTimeout(() => focusCard(), 120)
}
show(mode)
const MODES = ['arrival', 'a-preview', 'a-markdown', 'b-narrow', 'b-clamp', 'b-markdown', 'free-text', 'free-only', 'attach', 'multi', 'middle', 'deadline']
function Fixture() {
  const t = useTheme(), [selected, choose] = useState(mode)
  useApp(s => s.statusDetail)
  // "File…" picks a fixed path instead of the system dialog.
  const renderer = useGpuixRequired() as { promptForPaths?: unknown }
  renderer.promptForPaths = async () => ['/tmp/fixture/settings-before.png']
  const narrow = selected.startsWith('b-')
  const column = narrow ? Number(process.env.QCARD_NARROW ?? 440) : Number(process.env.QCARD_WIDTH ?? 700)
  return <div testId="fixture-ready" style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', position: 'relative', backgroundColor: WALLPAPER ? 'rgba(0, 0, 0, 0)' : t.surface }}>
    {WALLPAPER && <img src={WALLPAPER} alt="" objectFit="cover" style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%' }} />}
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: 18 }}>{MODES.map(name => <Button key={name} testId={`fixture-${name}`} variant={selected === name ? 'secondary' : 'ghost'} onClick={() => { choose(name); show(name) }}>{name}</Button>)}</div>
    <div style={{ flexGrow: 1 }} />
    {responded && <div testId="responded" aria-label={responded} style={{ width: 1, height: 1 }} />}
    <div testId="fixture-column" style={{ display: 'flex', flexDirection: 'column', width: column, alignSelf: 'center', paddingBottom: 24 }}>
      <ThreadRequests />
      <Label color={t.textTertiary} size={10}>{`Native fixture · ${column} pt column · all actions stay in memory`}</Label>
    </div>
  </div>
}
render(<ThemeProvider><Fixture /></ThemeProvider>, { title: 'Question card', width: 1024, height: 760, focus: false, onKeyDown: onWindowKeyDown })
process.stdin.on('end', () => { server.stop(true); process.exit(0) })
process.stdin.on('close', () => { server.stop(true); process.exit(0) })
