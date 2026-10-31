import { expect, test } from 'bun:test'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import type { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import type { ProvisionPlan } from '../../../../packages/kybern-client/src/types.ts'
import { useProvisionPlan } from './plan.ts'

const entry = createRequire(import.meta.url).resolve('@gpuix/react')
const { createRoot, flushSync } = await import(pathToFileURL(path.join(path.dirname(entry), 'reconciler/reconciler.js')).href)
const settle = async () => { await Bun.sleep(2); flushSync(() => {}); await Bun.sleep(2) }
const plan = (folder: string, state = 'free', targetPath = 'frontend'): ProvisionPlan => ({
  project_id: 'source', project_name: 'Workspace', kind: 'group', source: { id: 'mac', name: 'Mac', os: 'macos', online: true },
  target: { id: 'pc', name: 'PC', os: 'linux', online: true }, target_home: '/home/me', suggested_path: '/home/me/work',
  repos: [], env_files: [], members: [{ path: 'web', target_path: targetPath, present: true }],
  path_check: { path: folder, state: state as 'free', message: state },
})

test('folder checks follow the typed path immediately and restore the initial member mapping on return', async () => {
  const pending: { params: Record<string, unknown>; resolve: (value: ProvisionPlan) => void }[] = []
  const source = { call: (_method: string, params: Record<string, unknown>) => new Promise<ProvisionPlan>((resolve) => pending.push({ params, resolve })) } as unknown as KybernClient
  let result: ReturnType<typeof useProvisionPlan>
  function Probe({ folder }: { folder: string | null }) { result = useProvisionPlan(source, 'source', 'pc', folder); return null }
  const root = createRoot({ applyBatch() { return [] } })
  const render = async (folder: string | null) => { flushSync(() => root.render(<Probe folder={folder} />)); await settle() }
  try {
    await render(null)
    pending.shift()!.resolve(plan('/home/me/work'))
    await settle()
    await render('~/work')
    expect(result!.checking).toBe(false)
    expect(result!.check?.state).toBe('free')
    await render('/home/me/other')
    expect(result!.checking).toBe(true)
    expect(result!.check).toBeNull()
    await Bun.sleep(320)
    pending.shift()!.resolve(plan('/home/me/other', 'not_empty', 'other-name'))
    await settle()
    expect(result!.check?.state).toBe('not_empty')
    expect(result!.plan?.members?.[0]?.target_path).toBe('other-name')
    await render('/home/me/work')
    expect(result!.checking).toBe(false)
    expect(result!.check?.path).toBe('/home/me/work')
    expect(result!.check?.state).toBe('free')
    expect(result!.plan?.members?.[0]?.target_path).toBe('frontend')
    // An old check arriving after the user returns to the original must never replace it.
    await render('/home/me/late')
    await Bun.sleep(320)
    const late = pending.shift()!
    await render('/home/me/work')
    late.resolve(plan('/home/me/late', 'forbidden', 'wrong'))
    await settle()
    expect(result!.plan?.members?.[0]?.target_path).toBe('frontend')
    expect(result!.checking).toBe(false)
  } finally { root.unmount() }
})

test('a source or retry change invalidates the old plan before the replacement RPC completes', async () => {
  const pending: ((value: ProvisionPlan) => void)[] = []
  const source = () => ({ call: () => new Promise<ProvisionPlan>((resolve) => pending.push(resolve)) }) as unknown as KybernClient
  const first = source(), second = source()
  let result: ReturnType<typeof useProvisionPlan>
  function Probe({ client, retry }: { client: KybernClient; retry: number }) { result = useProvisionPlan(client, 'source', 'pc', '/home/me/work', undefined, retry); return null }
  const root = createRoot({ applyBatch() { return [] } })
  const render = async (client: KybernClient, retry = 0) => { flushSync(() => root.render(<Probe client={client} retry={retry} />)); await settle() }
  try {
    await render(first)
    const old = pending.shift()!
    await render(second)
    old(plan('/home/me/work'))
    await settle()
    expect(result!.plan).toBeNull()
    pending.shift()!(plan('/home/me/work'))
    await settle()
    expect(result!.plan).not.toBeNull()
    await render(second, 1)
    expect(result!.plan).toBeNull()
    pending.shift()!(plan('/home/me/work', 'not_empty'))
    await settle()
    expect(result!.check?.state).toBe('not_empty')
  } finally { root.unmount() }
})
