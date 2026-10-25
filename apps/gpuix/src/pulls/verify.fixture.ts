/** Deterministic, in-memory RPC fixture. No GitHub or real daemon writes. */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { PROTOCOL_VERSION } from '../../../../packages/kybern-client/src/types.ts'
import type { PrDetailResult, PrFile, PrReviewEntry, PullRequest, UsageRow } from '../../../../packages/kybern-client/src/types.ts'

export function actionFixture(options: { long?: boolean; /** Extra running checks beyond the one in the base fixture. */ running?: number; /** A group project of three repositories (ADE-79): api and docs both have #108, web fails, infra is skipped. */ group?: boolean } = {}) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'gpuix-scratch-pages-'))
  const now = new Date().toISOString()
  const members = ['api', 'web', 'docs', 'infra'].map(path => ({ path, name: path, status: 'ok' as const }))
  const project = options.group
    ? { id: 'pages-fixture', name: 'Acme', path: '/tmp/kybern-pages-fixture', is_git: false, kind: 'group' as const, members, created_at: now, updated_at: now }
    : { id: 'pages-fixture', name: 'Kybern fixture', path: '/tmp/kybern-pages-fixture', is_git: true, created_at: now, updated_at: now }
  const params: { method: string; params: Record<string, unknown> }[] = []
  const pr: PullRequest = { number: 108, title: 'Preserve reading position while streaming', url: 'https://example.com/pull/108', state: 'OPEN', head: 'fix/reading-position', base: 'main', is_draft: false, author: 'reviewer', updated_at: now, created_at: now, additions: 240, deletions: 28, mergeable: 'MERGEABLE', review_decision: 'APPROVED', checks_summary: { total: 3, passed: 2, failed: 0, pending: 1, skipped: 0 }, labels: [{ name: 'performance', color: '4285f4' }] }
  const detail: PrDetailResult = { pull_request: pr, body: '## Summary\n\nPreserve the reader’s position while a turn streams.\n\n- Stable rows keep their identity.\n- A bounded native list keeps old messages reachable.\n- Keyboard navigation remains immediate.\n\n### Verification\n\nChecked selection, wrapping, and follow behavior.', head_sha: '1234567890abcdef', reviewers: ['teammate'], checks: [{ name: 'Typecheck', status: 'COMPLETED', conclusion: 'SUCCESS', url: '' }, { name: 'Tests', status: 'COMPLETED', conclusion: 'SUCCESS', url: '' }, { name: 'Native visual verification', status: 'IN_PROGRESS', conclusion: '', url: '' }, ...Array.from({ length: options.running ?? 0 }, (_, i) => ({ name: `Running job ${i + 2}`, status: 'IN_PROGRESS', conclusion: '', url: '' }))], changed_files: 65, merge_state_status: 'CLEAN', reviews: [{ login: 'teammate', state: 'APPROVED' }], comment_count: 45 }
  const files: PrFile[] = Array.from({ length: 30 }, (_, i) => ({ path: `src/components/Transcript${i}.tsx`, old_path: null, status: 'modified', additions: 1200, deletions: 1200, patch_truncated: false, patch: `@@ -1,1200 +1,1200 @@\n${Array.from({ length: 1200 }, (_, j) => `-const row${j} = renderOld(${j});\n+const row${j} = renderStable(${j});`).join('\n')}` }))
  const entries: PrReviewEntry[] = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, author: i % 2 ? 'teammate' : 'reviewer', body: `### Finding ${i + 1}\n\nKeep this row stable while streaming.\n\n\`row.id\` should survive a refresh.\n\n- Preserve focus\n- Preserve selection\n- Recheck wrapping`, state: i % 2 ? 'COMMENTED' : 'APPROVED', path: i % 3 ? null : 'src/components/Transcript.tsx', line: i % 3 ? null : i + 1, side: 'RIGHT', url: '', updated_at: now }))
  const usage = (key: string, n: number): UsageRow => ({ key, turns: n, usage: { input_tokens: n * 2400, output_tokens: n * 1200, cache_read_tokens: n * 8000, cache_write_tokens: n * 300 }, cost_usd: n * .52 })
  let problem: 'missing' | 'auth' | null = null
  const calls: string[] = []
  const actions: Record<string, unknown>[] = []
  let failAction = false
  let empty = false
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, server) {
      // WebKit uses the browser session-ticket path; the in-memory fixture
      // accepts only its nonsecret local credential and never forwards it.
      const headers = { 'access-control-allow-origin': req.headers.get('origin') ?? '*', 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'POST,OPTIONS', 'vary': 'Origin' }
      if (new URL(req.url).pathname === '/session') {
        if (req.method === 'OPTIONS') return new Response(null, { headers })
        if (req.method === 'POST' && req.headers.get('authorization') === 'Bearer local-fixture') return Response.json({ ticket: 'fixture-ticket' }, { headers })
        return new Response('Unauthorized', { status: 401, headers })
      }
      if (server.upgrade(req)) return
      return new Response('Not found', { status: 404 })
    },
    websocket: {
      message(ws, raw) {
        const message = JSON.parse(String(raw)) as { id: string; method: string; params: Record<string, unknown> }
        calls.push(message.method)
        params.push({ method: message.method, params: message.params })
        let result: unknown = {}
        let error: string | undefined
        switch (message.method) {
          case 'daemon.info': result = { protocol_version: PROTOCOL_VERSION, environment_id: 'pages-fixture', version: 'fixture', scopes: [] }; break
          case 'projects.list': result = { projects: [project] }; break
          case 'threads.list': result = { threads: [{id:'linked',project_id:project.id,title:'Linked conversation',provider:{kind:'codex',instance:'default'},status:'idle',permission_mode:'supervised',worktree:{branch:pr.head,path:project.path},created_at:now,updated_at:now}], activity: [] }; break
          case 'queue.list': result = { messages: [] }; break
          case 'providers.list': result = { providers: [] }; break
          case 'providers.accounts.list': result = { accounts: [] }; break
          case 'settings.get': result = { default_provider: 'claude-code', default_permission_mode: 'supervised' }; break
          case 'events.subscribe': result = { subscription_id: 'fixture', head_seq: 0, replay_ready: true }; break
          case 'usage.limits': result = { providers: [], accounts: [], refreshing: [] }; break
          case 'usage.summary': {
            const rows = message.params.group_by === 'day' ? Array.from({ length: 30 }, (_, i) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - 29 + i); return usage(d.toISOString().slice(0, 10), 5 + (i * 17) % 50) }) : [usage(message.params.group_by === 'model' ? 'claude-opus-5-5' : 'claude-code', 420), usage(message.params.group_by === 'model' ? 'gpt-6' : 'codex', 260)]
            result = { rows, total: usage('total', 680) }; break
          }
          case 'github.pr.list':
            if (problem) error = problem === 'missing' ? 'gh: command not found' : 'authentication required; run gh auth login'
            else if(empty) result = {pull_requests:[]}
            else if (options.group) result = {
              pull_requests: [
                { ...pr, repo: 'api', title: 'Add SSO to the API' },
                { ...pr, repo: 'api', number: 109, title: 'Rate-limit login', updated_at: new Date(Date.now() - 3600_000).toISOString() },
                { ...pr, repo: 'docs', title: 'Document SSO setup', updated_at: new Date(Date.now() - 600_000).toISOString() },
              ],
              repos: [
                { repo: 'api', name: 'api' },
                { repo: 'web', name: 'web', error: 'HTTP 401: Bad credentials. Run gh auth login, then refresh.' },
                { repo: 'docs', name: 'docs' },
                { repo: 'infra', name: 'infra', error: 'No GitHub remote', skipped: true },
              ],
            }
            else result = { pull_requests: Array.from({ length: 30 }, (_, i) => ({ ...pr, number: 108 + i, title: i ? `Review change ${i}` : pr.title })) }
            break
          case 'github.pr.action': actions.push(message.params); if(failAction)error='Fixture action rejected';else result={message:'Done'};break
          case 'github.pr.detail': if (options.group && typeof message.params.repo !== 'string') { error = 'Acme has several repositories, so this pull request needs its repository.'; break }
            result = { ...detail, ...(options.long ? { body: Array.from({length: 40}, (_,i) => `### Verification ${i+1}\n\nPreserve **formatted content**, reading position and selection while scrolling.\n\n- Stable rows keep their identity.\n- The complete description remains reachable.\n\n\`row.id\` survives a refresh.`).join('\n\n') } : {}), pull_request: { ...pr, number: Number(message.params.number) } }; break
          case 'github.pr.page': result = { files: message.params.kind === 'files' ? files : [], entries: message.params.kind === 'files' ? [] : entries, page: message.params.page ?? 1, has_more: (Number(message.params.page) || 1) < 3 }; break
          default: if (!['events.unsubscribe', 'ping'].includes(message.method)) error = `Fixture rejects ${message.method}`
        }
        ws.send(JSON.stringify(error ? { jsonrpc: '2.0', id: message.id, error: { code: -32000, message: error } } : { jsonrpc: '2.0', id: message.id, result }))
      },
    },
  })
  const url = `ws://127.0.0.1:${server.port}/ws`
  const artifacts = [
    path.join(homedir(), 'Library/Application Support/kybern-gpuix', `workspace-${createHash('sha1').update(url).digest('hex').slice(0, 12)}.json`),
    path.join(homedir(), 'Library/Caches/kybern-gpuix', `providers-${url.replace(/[^a-z0-9]+/gi, '_')}.json`),
  ].map(file => ({ file, before: existsSync(file) ? readFileSync(file) : null }))
  return {
    env: { KYBERN_URL: url, KYBERN_TOKEN: 'local-fixture', GPUIX_BACKGROUND: '1', KYBERN_DATA_DIR: scratch, KYBERN_CLIENT_CONFIG_DIR: scratch, KYBERN_GPUIX_CREDENTIALS_DIR: scratch },
    calls, params, actions, fail: (value:boolean)=>{failAction=value}, empty:(value:boolean)=>{empty=value},
    problem: (kind: typeof problem) => { problem = kind },
    close: () => {
      server.stop(true)
      rmSync(scratch, { recursive: true, force: true })
      // Call after closing the app so its deferred preferences cannot recreate files.
      for (const { file, before } of artifacts) {
        if (before) writeFileSync(file, before)
        else if (existsSync(file)) unlinkSync(file)
      }
    },
  }
}
