import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const config = mkdtempSync(path.join(tmpdir(), 'gpuix-windows-'))
process.env.KYBERN_CLIENT_CONFIG_DIR = config
const { openWindowFor, windowClaims } = await import('./registry.ts')
const hosts: ReturnType<typeof Bun.spawn>[] = []
async function host(environment: string) {
  const child = Bun.spawn(['bun', path.join(import.meta.dir, 'host.fixture.ts'), environment], { env: { ...process.env, KYBERN_CLIENT_CONFIG_DIR: config }, stdin: 'pipe', stdout: 'pipe' })
  hosts.push(child)
  const reader = child.stdout.getReader(), lines: string[] = []
  const next = async () => { for (;;) { const { value } = await reader.read(); const text = new TextDecoder().decode(value); lines.push(...text.split('\n').filter(Boolean)); if (lines.length) return lines.shift()! } }
  expect(await next()).toBe('ready')
  for (let i = 0; i < 100 && !windowClaims().some(c => c.pid === child.pid); i++) await Bun.sleep(20)
  return { child, next }
}
beforeAll(() => {})
afterAll(() => { for (const child of hosts) child.kill(); rmSync(config, { recursive: true, force: true }) })

test('focuses the window that already shows the environment instead of opening another', async () => {
  const a = await host('env-a')
  let opened = 0
  const result = await openWindowFor('env-a', () => { opened++; return 1 })
  expect(result).toEqual({ action: 'focused', pid: a.child.pid })
  expect(await a.next()).toBe('focus')
  expect(opened).toBe(0)
})
test('opens a window when none shows it, and a second request waits for that window', async () => {
  let spawned: Awaited<ReturnType<typeof host>> | undefined
  const open = (id: string) => { void host(id).then(h => { spawned = h }); return -1 }
  // The pending claim holds a pid; use a real one that is starting.
  const late = Bun.spawn(['bun', path.join(import.meta.dir, 'host.fixture.ts'), 'env-b'], { env: { ...process.env, KYBERN_CLIENT_CONFIG_DIR: config }, stdin: 'pipe', stdout: 'pipe' }); hosts.push(late)
  const first = await openWindowFor('env-b', () => late.pid)
  expect(first).toEqual({ action: 'opened', pid: late.pid })
  const second = await openWindowFor('env-b', open)
  expect(second).toEqual({ action: 'focused', pid: late.pid })
  expect(spawned).toBeUndefined()
})
test('drops claims of windows that exited and of windows that switched away', async () => {
  const c = await host('env-c')
  c.child.stdin!.write('env-d\n'); expect(await c.next()).toBe('switched')
  let opened = 0
  expect((await openWindowFor('env-c', () => { opened++; return process.pid })).action).toBe('opened')
  expect(opened).toBe(1)
  const gone = await host('env-e'); gone.child.kill(); await gone.child.exited
  expect(windowClaims().some(claim => claim.pid === gone.child.pid)).toBe(false)
})
