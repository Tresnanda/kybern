// Group projects in the real window against a scratch daemon, before the daemon serves them (lanes A2a/A2b): the scratch
// daemon holds real single projects and the group folder as a plain project; this fixture's `client.call` wrapper turns
// that project into a group and answers the group RPCs (`projects.scan_repos`, `projects.members.status`, `git.branches
// { repo }`, `projects.instructions.create`, `github.pr.create_group`) and a group thread's `threads.get`, `threads.diff`
// and `git.status` exactly in the protocol's shapes. Nothing outside the scratch folders is read or written.
//
//   GROUPS_FIXTURE=<scratch dir with acme/ and state.json> KYBERN_DATA_DIR=<…gpuix-scratch…/data> bun src/groups/verify.fixture.tsx
import '../native/local-build.ts'
import { render, useGpuixRequired } from '@gpuix/react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { useEffect, useState } from 'react'
import type {
  Diff,
  GitStatus,
  Project,
  ProjectsMembersStatusResult,
  ProjectsScanReposResult,
  Thread,
  ThreadMember,
  TranscriptEntry,
} from '../../../../packages/kybern-client/src/types.ts'
import { App } from '../App.tsx'
import { onWindowKeyDown } from '../nav/keys.ts'
import { connect, getClient, refreshLists } from '../state.ts'
import { setNav } from '../nav/store.ts'
import { ThemeProvider } from '../ui.tsx'

const root = process.env.GROUPS_FIXTURE ?? ''
if (!root.includes('gpuix-scratch') || !process.env.KYBERN_DATA_DIR?.includes('gpuix-scratch')) throw Error('Group fixture requires scratch paths')
process.env.KYBERN_GROUPS = '1'
const acme = path.join(root, 'acme')
const state = JSON.parse(readFileSync(path.join(root, 'state.json'), 'utf8')) as { groupProjectId: string; threadId: string }
const variant = (name: string) => (process.env.GROUPS_VARIANT ?? '').split(',').includes(name)
const at = '2026-10-24T03:00:00Z'

const members = () => [
  { path: 'api', name: 'api', status: 'ok' as const },
  { path: 'web', name: 'web', status: variant('missing') ? ('missing' as const) : ('ok' as const) },
  { path: 'infra', name: 'infra', status: 'ok' as const },
]
let worktreeCopy = ['.env', 'scripts']
let dismissed = false
let created = false

const statusResult = (): ProjectsMembersStatusResult => ({
  members: [
    { path: 'api', name: 'api', status: 'ok', branch: 'main', dirty_files: 0, remote_url: 'git@github.com:acme/api.git', instructions: 'api/AGENTS.md' },
    { path: 'web', name: 'web', status: variant('missing') ? 'missing' : 'ok', branch: 'feat/login', dirty_files: 3, remote_url: 'git@github.com:acme/web.git', instructions: 'web/CLAUDE.md' },
    { path: 'infra', name: 'infra', status: 'ok', branch: 'main', dirty_files: 0, remote_url: 'git@github.com:acme/infra.git', instructions: null },
  ],
  agents_md: created || variant('instructions'),
  claude_md: created || variant('instructions'),
  copy_candidates: [
    { name: '.env', is_dir: false }, { name: '.git', is_dir: true }, { name: 'Makefile', is_dir: false }, { name: 'api', is_dir: true },
    { name: 'docker-compose.yml', is_dir: false }, { name: 'infra', is_dir: true }, { name: 'scripts', is_dir: true }, { name: 'web', is_dir: true },
  ],
})

const scanResult = (include: string[] = []): ProjectsScanReposResult => ({
  path: acme,
  name: 'acme',
  is_git: variant('git'),
  candidates: variant('empty') ? [] : [
    ...(variant('git') ? [{ path: '.', name: 'acme', branch: 'main' }] : []),
    { path: 'api', name: 'api', branch: 'main' },
    { path: 'web', name: 'web', branch: 'feat/login' },
    { path: 'infra', name: 'infra', branch: 'main' },
    ...(variant('git') ? [] : [
      { path: 'services/billing', name: 'billing', branch: 'main' },
      { path: 'packages/design-tokens', name: 'design-tokens', branch: 'main', submodule_of: 'web' },
    ]),
    ...include.filter((p) => p === 'deep/docs').map((p) => ({ path: p, name: 'docs', branch: 'main', added: true })),
  ],
})

const container = path.join(root, 'worktrees', 'acme', state.threadId)
const threadMembers = (): ThreadMember[] => [
  ...['api', 'web', 'infra'].map((p) => ({ path: p, name: p, included: true, source_path: path.join(acme, p), worktree: { path: path.join(container, p), branch: `kybern/${state.threadId}` }, base_branch: p === 'web' ? 'feat/login' : 'main' })),
  { path: 'docs', name: 'docs', included: false, source_path: path.join(acme, 'docs'), base_branch: 'main' },
]
const thread = (): Thread => ({
  id: state.threadId, project_id: state.groupProjectId, parent_thread_id: null, coordinator_project_id: null,
  title: 'Add SSO to the admin console', provider: { kind: 'claude-code', instance: 'default' }, model: null, effort: null,
  permission_mode: 'full-access' as Thread['permission_mode'], status: 'idle', worktree: { path: container, branch: `kybern/${state.threadId}` }, cwd: container,
  provider_session_id: null, pinned: false, created_at: at, updated_at: at, last_seq: 4, members: threadMembers(),
})
const file = (p: string, repo: string, additions: number, deletions: number) => ({ path: p, status: 'modified' as const, additions, deletions, binary: false, repo })
const diff = (): Diff => ({
  from: 'a1', to: 'b2', patch: '',
  files: [
    file('api/src/auth/sso.rs', 'api', 42, 3), file('api/src/http/routes.rs', 'api', 9, 2), file('api/Cargo.toml', 'api', 1, 0),
    file('web/src/admin/login/SsoButton.tsx', 'web', 31, 0), file('web/src/admin/login/LoginPage.tsx', 'web', 6, 4), file('web/src/i18n/en.json', 'web', 2, 0),
  ],
  repos: [
    { repo: 'api', from: 'a1', to: 'b2', files: 3, additions: 52, deletions: 5 },
    { repo: 'web', from: 'c3', to: 'd4', files: 3, additions: 39, deletions: 4 },
    { repo: 'infra', from: 'e5', to: 'e5', files: 0, additions: 0, deletions: 0 },
  ],
})
const pr = (n: number, title: string, repo: string, draft = false) => ({ number: n, title, url: `https://github.com/acme/${repo}/pull/${n}`, state: 'OPEN', head: `kybern/${state.threadId}`, base: 'main', is_draft: draft, author: 'me', updated_at: at })
let prsOpened = variant('prs')
const gitStatus = (): GitStatus => {
  const repo = (name: string, dirty: number, ahead: number, extra: Partial<GitStatus> = {}) => ({ repo: name, name, included: name !== 'docs', status: 'ok' as const, is_git: true, branch: `kybern/${state.threadId}`, dirty_files: dirty, ahead, behind: 0, remote_url: `git@github.com:acme/${name}.git`, ...extra })
  return {
    is_git: true, branch: `kybern/${state.threadId}`, dirty_files: 3, ahead: 1, behind: 0, remote_url: 'git@github.com:acme/api.git',
    repos: [
      repo('api', 3, 1, prsOpened ? { pull_request: pr(128, 'Add SSO callback to the admin API', 'api') } : {}),
      repo('web', 3, 1, prsOpened ? { pull_request: pr(77, 'Add the SSO button to the admin login', 'web', true) } : {}),
      repo('infra', 0, 0),
      repo('docs', 0, 0),
    ],
  }
}
const transcript = (): TranscriptEntry[] => [
  { role: 'user', id: 'u1', turn_id: 't1', seq: 1, at, message: { parts: [{ type: 'text', text: 'Add SSO to the admin console. The API needs the callback, the web app the button.' }] } },
  { role: 'assistant', id: 'a1', turn_id: 't1', seq: 2, at, origin: { kind: 'root' }, text: 'Added the SSO callback to **api** (`/auth/sso/callback`, behind the existing session middleware) and a "Sign in with SSO" button to the **web** admin login. Each repository has its own commit-ready changes.' },
  { role: 'turn_summary', turn_id: 't1', seq: 3, at, stop_reason: 'completed', usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }, duration_ms: 252000 },
  { role: 'outside_repo_changed', turn_id: 't1', seq: 4, at, repos: [{ repo: 'docs', name: 'docs', source_path: path.join(acme, 'docs'), dirty_files: 2 }] },
] as TranscriptEntry[]

function groupify(project: Project): Project {
  return project.id === state.groupProjectId
    ? { ...project, name: 'acme-platform', kind: 'group', is_git: variant('git'), members: members(), worktree_copy: worktreeCopy, instructions_offer_dismissed: dismissed }
    : project
}

connect()
function Fixture() {
  const renderer = useGpuixRequired()
  const [ready, setReady] = useState(false)
  const [client, setClient] = useState(getClient())
  useEffect(() => {
    if (client) return
    const timer = setInterval(() => { const next = getClient(); if (next) { clearInterval(timer); setClient(next) } }, 20)
    return () => clearInterval(timer)
  }, [client])
  useEffect(() => {
    if (!client) return
    const call = client.call.bind(client)
    client.call = (async (method: string, params: Record<string, any> = {}) => {
      if (method === 'daemon.info') return { ...(await call('daemon.info', {})), version: '0.15.0' }
      if (method === 'projects.list') {
        const result = await call('projects.list', params as never)
        return { ...result, projects: result.projects.map(groupify) }
      }
      if (method === 'projects.update' && params.project_id === state.groupProjectId) {
        if (params.worktree_copy) worktreeCopy = params.worktree_copy
        if (params.instructions_offer_dismissed !== undefined) dismissed = params.instructions_offer_dismissed
        const project = (await call('projects.list', { refresh_git: false })).projects.find((p) => p.id === state.groupProjectId)!
        return groupify(project)
      }
      if (method === 'projects.scan_repos') {
        if (variant('slow')) return new Promise(() => {})
        return scanResult(params.include ?? [])
      }
      if (method === 'projects.members.status') return statusResult()
      if (method === 'projects.instructions.create') { created = true; return { created: ['AGENTS.md', 'CLAUDE.md'] } }
      if (method === 'git.branches' && params.project_id === state.groupProjectId) {
        const current = params.repo === 'web' ? 'feat/login' : 'main'
        const names = params.repo === 'web' ? ['feat/login', 'main', 'fix/session-expiry'] : ['main', 'release/2026-10']
        return { current, branches: names.map((name) => ({ name, is_current: name === current })) }
      }
      if (method === 'threads.list') {
        const result = await call('threads.list', params as never)
        return { ...result, threads: [thread(), ...result.threads] }
      }
      if (params.thread_id === state.threadId) {
        if (method === 'threads.get') return { thread: thread(), transcript: transcript(), pending_approvals: [], next_before_seq: null }
        if (method === 'threads.diff') return diff()
        if (method === 'git.status') return gitStatus()
        if (method === 'github.pr.create_group') {
          await new Promise((r) => setTimeout(r, 600))
          prsOpened = true
          return { pull_requests: [{ repo: 'api', pull_request: pr(128, 'Add SSO callback to the admin API', 'api') }, { repo: 'web', pull_request: pr(77, 'Add the SSO button to the admin login', 'web', true) }] }
        }
        // Reads the transcript page makes for any thread: empty, as for a fresh one.
        if (method === 'threads.messages.list') return { messages: [] }
        if (method === 'notes.get') return { note: null }
        // Anything else (events, tasks, queue, file links) goes to the scratch daemon as for any thread it doesn't know.
        return call(method as never, params as never)
      }
      return call(method as never, params as never)
    }) as typeof client.call
    const original = renderer.promptForPaths
    // The next folder a picker returns: the verify script writes it, so no real panel ever opens.
    renderer.promptForPaths = async () => {
      try { return [readFileSync(path.join(root, 'next-pick.txt'), 'utf8').trim()] } catch { return [acme] }
    }
    // The first lists and `daemon.info` may have been read before this wrapper: read them again through it.
    void refreshLists()
    void client.call('daemon.info', {}).then((info) => setNav({ version: info.version ?? null }))
    setReady(true)
    return () => { renderer.promptForPaths = original; client.call = call }
  }, [renderer, client])
  return <div style={{ display: 'flex', width: '100%', height: '100%' }}>{ready && <App />}</div>
}
render(<ThemeProvider><Fixture /></ThemeProvider>, { title: 'Group projects verification', width: 1280, height: 820, focus: false, onKeyDown: onWindowKeyDown })
process.stdin.on('end', () => process.exit(0))
