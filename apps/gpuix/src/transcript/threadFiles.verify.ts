import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
const root = mkdtempSync(path.join(tmpdir(), 'kybern-thread-files-'))
const actions: string[] = [], notices: string[] = [], failures: unknown[] = []
let requests = 0, machineName = 'Away'
const client = { fetch: async (_url: string, options: RequestInit) => { requests++; return new Headers(options.headers).get('If-None-Match') === 'same' ? new Response(null, { status: 304 }) : new Response(new Uint8Array([0, 255, 7]), { headers: { etag: 'same', 'content-length': '3' } }) } }
mock.module('../state.ts', () => ({ getState: () => ({ threads: [{ id: 'local', cwd: root }, { id: 'remote', cwd: '/remote/project' }], open: {} }), machineOfThreadId: (id: string) => id === 'remote' ? 'away' : undefined, requireThreadClient: () => client, ownProjectId: (t: { project_id: string }) => t.project_id }))
mock.module('../nav/store.ts', () => ({ getNav: () => ({ children: { child: { id: 'child', cwd: path.join(root, 'child') } } }) }))
mock.module('../machines/index.ts', () => ({ machineHub: () => ({ set: { displayName: () => machineName } }) }))
mock.module('../shell/environment.ts', () => ({ activeEnvironment: () => ({ local: true, name: 'Here' }) }))
mock.module('../platform/os.ts', () => ({ downloadsDir: () => root, openTarget: async (target: string) => { actions.push(target) }, revealPath: async (target: string) => { actions.push(target) } }))
mock.module('../shell/toasts.tsx', () => ({ toast: Object.assign((text: string) => notices.push(text), { dismiss: () => {} }) }))
mock.module('../problems/toast.ts', () => ({ toastProblem: (error: unknown) => failures.push(error) }))
mock.module('../dock/explorerSelection.ts', () => ({ showFileInExplorer: () => {} }))
const { actOnThreadFile, threadFilesAreLocal } = await import('./threadFiles.ts')
try {
  assert.equal(threadFilesAreLocal('local'), true)
  assert.equal(threadFilesAreLocal('remote'), false, 'the window being local does not make a remote thread local')
  await actOnThreadFile('local', 'report.pdf', 'reveal')
  assert.equal(actions[0], path.join(root, 'report.pdf')); assert.equal(requests, 0)
  await actOnThreadFile('child', 'artifact.png', 'reveal')
  assert.equal(actions[1], path.join(root, 'child/artifact.png'), 'a local subagent uses its own cwd even when it is outside the normal thread list')
  await actOnThreadFile('remote', 'reports/report.pdf', 'open')
  const copy = path.join(root, 'Kybern', 'Away', 'reports', 'report.pdf')
  assert.equal(actions[2], copy); assert.deepEqual([...readFileSync(copy)], [0, 255, 7])
  assert.ok(notices.includes('Downloaded a copy from Away. Changes stay on this computer.'))
  writeFileSync(copy, 'Edited locally')
  await actOnThreadFile('remote', 'reports/report.pdf', 'reveal')
  assert.equal(requests, 2); assert.equal(readFileSync(copy, 'utf8'), 'Edited locally', 'unchanged remote files reuse the local copy, including its edits')
  machineName = '../escape'
  await actOnThreadFile('remote', 'reports/safe.pdf', 'open')
  assert.ok(actions.at(-1)!.startsWith(path.join(root, 'Kybern') + path.sep), 'a machine display name cannot escape Downloads/Kybern')
  assert.deepEqual(failures, [])
} finally { rmSync(root, { recursive: true, force: true }) }
