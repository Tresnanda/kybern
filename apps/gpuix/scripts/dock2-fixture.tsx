import assert from 'node:assert/strict'
import type { Pointer } from 'bun:ffi'
import { isWindowVisible } from '../src/native/visibility.ts'
import { each, getObjc, nsApp, sel } from '../src/native/objc.ts'
import { getClient, getState, set, subscribe } from '../src/state.ts'
import { setPreview } from '../src/preview/store.ts'
import '../src/main.tsx'
assert.ok(process.env.KYBERN_DATA_DIR?.includes('gpuix-scratch') || process.env.KYBERN_DATA_DIR?.endsWith('/apps/gpuix/.combined/data'), 'Use an isolated scratch data directory')
const client = getClient()!, call = client.call.bind(client)
let frame = 0
if (process.env.DOCK2_CONTROL_PORT) Bun.serve({ hostname: '127.0.0.1', port: Number(process.env.DOCK2_CONTROL_PORT), fetch(req) {
  const action = new URL(req.url).pathname
  if (action === '/show' || action === '/minimize') {
    const o = getObjc(), app = nsApp()
    if (app) each(o, o.msg(app, sel(o, 'windows')) as Pointer, w => {
      if (action === '/minimize') o.msgSetPtr(w, sel(o, 'miniaturize:'), null as unknown as Pointer)
      else { if (Number(o.msgU64(w, sel(o, 'isMiniaturized'))) & 0xff) o.msgSetPtr(w, sel(o, 'deminiaturize:'), null as unknown as Pointer); o.msgSetPtr(w, sel(o, 'orderFront:'), null as unknown as Pointer) }
    })
  }
  return Response.json({ frames: frame, visible: isWindowVisible() })
} })

if (process.env.DOCK2_LIVE === '1') {
  const image = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="#e8eef5"/><rect x="24" y="24" width="592" height="352" rx="16" fill="white"/><text x="52" y="80" font-size="26" fill="#182337">Scratch live-view fixture</text><text x="52" y="128" font-size="18" fill="#526273">The latest agent frame stays in memory.</text><rect x="52" y="180" width="190" height="48" rx="10" fill="#3566b1"/><text x="76" y="211" font-size="18" fill="white">Continue</text></svg>').toString('base64')
  client.call = (async (method: string, params: unknown) => {
    if (method === 'settings.get') { const result = await call('settings.get', {}); return { ...result, computer_use: { ...result.computer_use, enabled: true } } }
    if (method === 'computer.frame') { console.log('[fixture frame]', ++frame); return { frame: { seq: frame, window_id: 1, app: 'Fixture', title: 'Scratch app', action: 'Pressed “Continue”', media_type: 'image/svg+xml', data: image, width: 640, height: 400, captured_at: new Date().toISOString() } } }
    return call(method as never, params as never)
  }) as typeof client.call
}
if (process.env.DOCK2_NOTE_DELAY === '1') {
  const previous = client.call.bind(client)
  client.call = (async (method: string, params: Record<string, unknown>) => {
    const result = await previous(method as never, params as never)
    if (method === 'notes.update' && params.expected_revision === 0) await new Promise(resolve => setTimeout(resolve, 1200))
    return result
  }) as typeof client.call
}
if (process.env.DOCK2_POPULATED === '1') {
  const now = new Date().toISOString()
  const pr = { number: 999999, title: 'Keep the latest output visible', url: 'https://example.com/pull/999999', state: 'OPEN', head: 'fixture/streaming', base: 'main', is_draft: false, author: 'fixture', updated_at: now, additions: 2, deletions: 1, mergeable: 'MERGEABLE' }
  const previous = client.call.bind(client)
  client.call = (async (method: string, params: Record<string, unknown>) => {
    if (method === 'github.pr.action' || method === 'threads.send' || method === 'queue.add') throw new Error('Read-only fixture rejects write actions')
    if (method === 'git.status') return { ...await call('git.status', params as never), pull_request: pr }
    if (method === 'github.pr.detail') return { pull_request: pr, body: '## Verification\n\nKeep the final output readable after the large burst.', head_sha: 'fixture1234567890', checks: [{ name: 'Typecheck', status: 'COMPLETED', conclusion: 'SUCCESS', url: '' }], reviewers: [], changed_files: 1, merge_state_status: 'CLEAN', reviews: [], comment_count: 0 }
    if (method === 'github.pr.page') return { files: params.kind === 'files' ? [{ path: 'src/output.ts', status: 'modified', additions: 2, deletions: 1, patch_truncated: false, patch: '@@ -1 +1,2 @@\n-renderAll();\n+renderVisible();\n+keepFinalOutput();' }] : [], entries: [], page: 1, has_more: false }
    if (method === 'threads.artifacts.list') return { artifacts: [{ seq: 1, at: now, call: { id: 'fixture-artifact', name: 'Artifact', input: { action: 'create', title: 'Scratch artifact', file_path: process.env.DOCK2_ARTIFACT } }, output: { url: 'https://claude.ai/artifacts/fixture' }, is_error: false }], next_before_seq: null }
    return previous(method as never, params as never)
  }) as typeof client.call
}
let initialized = false
const off = subscribe(() => {
  const s = getState()
  if (initialized || !s.selectedId || s.open.thread?.id !== s.selectedId) return
  initialized = true; off()
  setPreview(s.selectedId, { entries: [{ address: 'http://localhost:5173', url: 'http://localhost:5173', title: 'Scratch website', kind: 'server' }], index: 0 })
  if (process.env.DOCK2_LIVE === '1') {
    set({ open: { ...s.open, thread: { ...s.open.thread, status: 'running' } } })
    // Order only this background fixture's window forward without activating it.
    // Actual occlusion remains enabled; a covered window must not poll frames.
    const o = getObjc(), app = nsApp()
    if (app) each(o, o.msg(app, sel(o, 'windows')) as Pointer, w => { if (Number(o.msgU64(w, sel(o, 'isVisible'))) & 0xff) o.msgSetPtr(w, sel(o, 'orderFront:'), null as unknown as Pointer) })
  }
})
