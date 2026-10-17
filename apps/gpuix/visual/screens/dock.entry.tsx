// Screenshot-only states. No model runs, browser launches, or real screen capture.
import { getClient, getState, set, subscribe } from '../../src/state.ts'
import { setPreview } from '../../src/preview/store.ts'
import '../../src/main.tsx'

if (!process.env.KYBERN_DATA_DIR?.includes('gpuix-scratch')) throw Error('Scratch data required')
const mode = process.env.DOCK_VISUAL_STATE
const client = getClient()!, call = client.call.bind(client)
client.call = (async (method: string, params: Record<string, unknown>) => {
  if (mode === 'servers' && method === 'previews.servers.list') return { servers: [
    { url: 'http://localhost:5173', port: 5173, host: 'localhost', process_name: 'node', cwd: '/workspace/kybern-app', title: 'Kybern', in_project: true },
    { url: 'http://localhost:3000', port: 3000, host: 'localhost', process_name: 'node', cwd: '/workspace/docs-site', title: 'Documentation', in_project: false },
  ], scanned_at: '2026-10-15T12:00:00Z', method: 'fixture' }
  if ((mode === 'diff' || mode === 'changes') && method === 'git.status') return { is_git: false }
  if (mode === 'diff' && method === 'threads.diff') return {
    patch: 'diff --git a/src/dock-example.ts b/src/dock-example.ts\n--- a/src/dock-example.ts\n+++ b/src/dock-example.ts\n@@ -1 +1,2 @@\n export const example = 1;\n+export const next = 2;',
    files: [{ path: 'src/dock-example.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1,2 @@\n export const example = 1;\n+export const next = 2;' }],
  }
  return call(method as never, params as never)
}) as typeof client.call
let initialized = false
const off = subscribe(() => {
  const s = getState()
  if (initialized || !s.selectedId || s.open.thread?.id !== s.selectedId) return
  initialized = true; off()
  if (mode === 'opened' || mode === 'mini') setPreview(s.selectedId, {
    entries: [{ address: 'https://example.com', url: 'https://example.com', title: 'example.com', kind: 'external' }], index: 0, opened: true, floating: mode === 'mini',
  })
})
