import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const config = mkdtempSync(path.join(tmpdir(), 'gpuix-windows-'))
process.env.KYBERN_CLIENT_CONFIG_DIR = config
const { askWindow, quitOtherWindows, socketPath, windowClaims } = await import('./registry.ts')
const hosts: ReturnType<typeof Bun.spawn>[] = []
async function host(name: string) {
  const child = Bun.spawn(['bun', path.join(import.meta.dir, 'host.fixture.ts'), name], { env: { ...process.env, KYBERN_CLIENT_CONFIG_DIR: config }, stdin: 'pipe', stdout: 'pipe' })
  hosts.push(child)
  const reader = child.stdout.getReader(), lines: string[] = []
  const next = async () => { for (;;) { const { value } = await reader.read(); const text = new TextDecoder().decode(value); lines.push(...text.split('\n').filter(Boolean)); if (lines.length) return lines.shift()! } }
  expect(await next()).toBe('ready')
  for (let i = 0; i < 100 && !windowClaims().some(c => c.pid === child.pid); i++) await Bun.sleep(20)
  return { child, next }
}
afterAll(() => { for (const child of hosts) child.kill(); rmSync(config, { recursive: true, force: true }) })

test('a window claims itself and comes to the front when asked', async () => {
  const a = await host('window-a')
  const claim = windowClaims().find(c => c.pid === a.child.pid)!
  expect(claim.name).toBe('window-a')
  expect('environment' in claim).toBe(false)
  const reply = await askWindow(claim, { type: 'focus' })
  expect(reply).toMatchObject({ ok: true, pid: a.child.pid, focused: 1 })
  expect(await a.next()).toBe('focus')
})
test('drops the claims of windows that exited', async () => {
  const gone = await host('window-gone'); gone.child.kill(); await gone.child.exited
  expect(windowClaims().some(claim => claim.pid === gone.child.pid)).toBe(false)
})
test('asks other windows to quit and reports the ones that stay', async () => {
  const a = await host('window-q1'), b = await host('window-q2')
  expect(await quitOtherWindows(5000)).toEqual([])
  await a.child.exited; await b.child.exited
  expect(windowClaims().some(claim => [a.child.pid, b.child.pid].includes(claim.pid))).toBe(false)
  // A process that claims a window but never answers is reported, not waited for forever.
  const stuck = Bun.spawn(['bun', '-e', 'setInterval(() => {}, 1000)'])
  hosts.push(stuck)
  mkdirSync(path.join(config, 'gpuix-windows'), { recursive: true })
  writeFileSync(path.join(config, 'gpuix-windows', `${stuck.pid}.json`), JSON.stringify({ pid: stuck.pid, socket: path.join(config, 'none.sock'), at: Date.now() }))
  expect(await quitOtherWindows(300)).toEqual([stuck.pid])
})
test('Windows windows listen on a named pipe', () => {
  expect(socketPath(42, 'win32')).toMatch(/^\\\\\.\\pipe\\kybern-gpuix-[0-9a-f]{12}-42$/)
})
