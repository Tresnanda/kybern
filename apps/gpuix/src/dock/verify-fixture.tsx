import { getClient } from '../state.ts'
import '../main.tsx'
if (!process.env.KYBERN_DATA_DIR?.includes('gpuix-scratch')) throw Error('Scratch data required')
const client = getClient()!, call = client.call.bind(client)
client.call = (async (method: string, params: unknown) => {
  if (method === 'threads.diff') return { patch: 'diff --git a/dock-example.ts b/dock-example.ts\n--- a/dock-example.ts\n+++ b/dock-example.ts\n@@ -1 +1,2 @@\n export const example = 1;\n+export const next = 2;', files: [{ path: 'dock-example.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1,2 @@\n export const example = 1;\n+export const next = 2;' }] }
  return call(method as never, params as never)
}) as typeof client.call
