// Deterministic native fixture for Settings › Skills: the page (in step, different, missing), the copy sheet (missing,
// replace) and its result. No daemon or skill folder is touched: an in-memory client answers. Drive it with `skills.shots.ts`.
import '../native/local-build.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { render } from '@gpuix/react'
import { useState } from 'react'
import { PROTOCOL_VERSION, type SkillCopyInfo, type SkillHome, type SkillsNetworkView } from '../../../../packages/kybern-client/src/types.ts'
import type { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import { connect, set, useApp } from '../state.ts'
import { ThemeProvider, useTheme, Label } from '../ui.tsx'
import { Button } from '../kit/Button.tsx'
import { onWindowKeyDown } from '../nav/keys.ts'
import { Skills } from './Skills.tsx'
import { CopySkillSheet } from './CopySkillSheet.tsx'
import { setSkillsFixture } from './store.ts'

const H = (n: number) => n.toString(16).padStart(64, '0')
const copy = (home: SkillHome, hash: string, extra: Partial<SkillCopyInfo> = {}): SkillCopyInfo => ({ home, path: `~/.${home}/skills/x`, hash, size: 4200, files: 3, ...extra })
const homes = (os: string) => (['agents', 'claude', 'codex', 'cursor', 'opencode', 'pi', 'omp'] as SkillHome[]).map((home) => ({ home, path: os === 'windows' ? `C:\\Users\\Bagus\\.${home}\\skills` : `/home/tresnanda/.${home}/skills`, exists: home !== 'omp' }))
const VIEW: SkillsNetworkView = {
  machines: [
    { id: 'macbook', name: 'MacBook', is_self: true, state: 'reported', os: 'macos', homes: homes('macos') },
    { id: 'os-kdi', name: 'os-kdi', is_self: false, state: 'reported', os: 'linux', homes: homes('linux') },
    { id: 'satyamas', name: 'satyamas', is_self: false, state: 'reported', os: 'windows', homes: homes('windows') },
    { id: 'vps', name: 'treshnandavps', is_self: false, state: 'offline', os: 'linux' },
  ],
  skills: [
    { name: 'better-ui', display_name: 'Better UI', description: 'Polishes surfaces, icons and motion with exact values for radius, shadows and animation.', versions: [H(1)], differs: false,
      machines: [{ machine_id: 'macbook', copies: [copy('agents', H(1)), copy('claude', H(1), { linked_to: 'agents', is_link: true })] }, { machine_id: 'os-kdi', copies: [copy('agents', H(1))] }, { machine_id: 'satyamas', copies: [copy('agents', H(1))] }] },
    { name: 'deploy-to-vercel', description: 'Deploys the current project to Vercel and reports the preview URL.', versions: [H(2)], differs: false,
      machines: [{ machine_id: 'macbook', copies: [copy('claude', H(2), { skipped: ['.env.local', 'node_modules/'] })] }, { machine_id: 'os-kdi', copies: [copy('claude', H(2))] }] },
    { name: 'expo-dev-client', description: 'Builds and distributes Expo development clients locally or through TestFlight.', versions: [H(3)], differs: false,
      machines: [{ machine_id: 'macbook', copies: [copy('agents', H(3)), copy('claude', H(3), { linked_to: 'agents', is_link: true })] }] },
    { name: 'grilling', description: 'Stress-tests a plan by asking hard questions until it holds.', versions: [H(4), H(5)], differs: true,
      machines: [{ machine_id: 'macbook', copies: [copy('claude', H(4))] }, { machine_id: 'os-kdi', copies: [copy('claude', H(5))] }, { machine_id: 'satyamas', copies: [copy('claude', H(4))] }] },
    { name: 'research', description: 'Runs a multi-step web research task and writes up the findings with sources.', versions: [H(6)], differs: false,
      machines: [{ machine_id: 'macbook', copies: [copy('agents', H(6))] }, { machine_id: 'os-kdi', copies: [copy('agents', H(6))] }, { machine_id: 'satyamas', copies: [copy('agents', H(6))] }] },
    { name: 'tdd', description: 'Writes the failing test first, then the smallest change that passes it.', versions: [H(7), H(8)], differs: true,
      machines: [{ machine_id: 'macbook', copies: [copy('codex', H(7))] }, { machine_id: 'satyamas', copies: [copy('codex', H(8))] }], pending: [{ machine_id: 'os-kdi', outbox_id: 'o1', from: 'macbook' }] },
  ],
}
let mode = new URLSearchParams(process.env.SKILLS_MODE ? `m=${process.env.SKILLS_MODE}` : '').get('m') ?? 'page'
const answer = (method: string): unknown => {
  if (method === 'skills.network_view') return VIEW
  if (method === 'skills.copy') return { source: 'macbook', name: 'grilling', hash: H(4), files: 3, bytes: 4200, skipped: [], targets: [
    { machine_id: 'os-kdi', name: 'os-kdi', state: 'queued', outbox_id: 'o2' },
    { machine_id: 'vps', name: 'treshnandavps', state: 'queued', outbox_id: 'o3' },
  ] }
  return {}
}
const fake = { status: 'open', call: (method: string) => new Promise((resolve) => setTimeout(() => resolve(answer(method)), 40)), onNotification: () => () => {} } as unknown as KybernClient
setSkillsFixture(() => fake)
const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(req, s) { if (s.upgrade(req)) return; return new Response('fixture') }, websocket: { message(ws, raw) {
  const request = JSON.parse(String(raw)); let result: unknown = {}
  switch (request.method) {
    case 'daemon.info': result = { protocol_version: PROTOCOL_VERSION, environment_id: 'macbook', version: 'fixture' }; break
    case 'projects.list': result = { projects: [] }; break
    case 'threads.list': result = { threads: [] }; break
    case 'tasks.list': result = { tasks: [] }; break
    case 'events.subscribe': result = { subscription_id: 'fixture', head_seq: 0, replay_ready: true }; break
  }
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }))
  set({ statusDetail: `${request.method}:${Date.now()}` })
} } })
process.env.KYBERN_URL = `ws://127.0.0.1:${server.port}/ws`
process.env.KYBERN_TOKEN = 'fixture'
if (!process.env.KYBERN_DATA_DIR) throw Error('Fixture requires an isolated data directory')
mkdirSync(process.env.KYBERN_DATA_DIR, { recursive: true })
writeFileSync(path.join(process.env.KYBERN_DATA_DIR, 'daemon.port'), String(server.port))
writeFileSync(path.join(process.env.KYBERN_DATA_DIR, 'daemon.token'), 'fixture', { mode: 0o600 })
connect()

const MODES = ['page', 'sheet-missing', 'sheet-replace', 'sheet-result']
const entryOf = (name: string) => VIEW.skills.find((skill) => skill.name === name)!

function Fixture() {
  useApp((s) => s.statusDetail)
  const t = useTheme(), [selected, choose] = useState(mode)
  const sheet = selected.startsWith('sheet')
  return <div testId="fixture-ready" style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', backgroundColor: t.surface }}>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: 14 }}>{MODES.map((name) => <Button key={name} size="sm" testId={`fixture-${name}`} variant={selected === name ? 'secondary' : 'ghost'} onClick={() => { mode = name; choose(name) }}>{name}</Button>)}</div>
    {!sheet && <virtual-list key="page" testId="settings-content" style={{ flexGrow: 1, minHeight: 0 }}>
      <div key="heading" style={{ display: 'flex', justifyContent: 'center', width: '100%', paddingTop: 10, paddingBottom: 30, paddingLeft: 40, paddingRight: 40 }}><div style={{ display: 'flex', flexDirection: 'column', width: '100%', maxWidth: 680, gap: 9 }}>
        <Label color={t.text} size={28} lineHeight={33.6} weight={600}>Skills</Label>
        <Label color={t.textSecondary} size={14} lineHeight={22.4}>Your skills on every machine, in the folders each agent reads. Copy one where it’s missing; nothing copies by itself.</Label>
      </div></div>
      <Skills inlineSheet />
      <div key="bottom" style={{ height: 40 }} />
    </virtual-list>}
    {sheet && <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, justifyContent: 'center', paddingBottom: 30 }}>
      <CopySkillSheet key={selected} inline view={VIEW} entry={entryOf(selected === 'sheet-missing' ? 'deploy-to-vercel' : 'grilling')} close={() => {}} />
    </div>}
    <Label color={t.textTertiary} size={10} style={{ padding: 6 }}>Native fixture · all actions stay in memory</Label>
  </div>
}
render(<ThemeProvider><Fixture /></ThemeProvider>, { title: 'Skills', width: 1024, height: 1000, focus: false, onKeyDown: onWindowKeyDown })
process.stdin.on('end', () => { server.stop(true); process.exit(0) })
process.stdin.on('close', () => { server.stop(true); process.exit(0) })
