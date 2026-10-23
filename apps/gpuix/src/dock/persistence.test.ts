import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
test('ordinary process exit saves dock layout without an environment switch', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gpuix-scratch-dock-'))
  const module = JSON.stringify(path.resolve(import.meta.dir, 'store.ts'))
  const env = { ...process.env, KYBERN_DATA_DIR: dir, KYBERN_CLIENT_CONFIG_DIR: path.join(dir, 'config'), KYBERN_URL: '', KYBERN_TOKEN: '' }
  try {
    const writer = Bun.spawn(['bun', '-e', `import { setDock } from ${module}; setDock('restart-test', { open: true, width: 612, tabs: ['activity', 'explorer'], tab: 'explorer', instant: true });`], { env, stdout: 'pipe', stderr: 'pipe' })
    expect(await writer.exited).toBe(0)
    const reader = Bun.spawn(['bun', '-e', `import { getDock } from ${module}; console.log(JSON.stringify(getDock('restart-test')))`], { env, stdout: 'pipe', stderr: 'pipe' })
    const saved = JSON.parse(await new Response(reader.stdout).text())
    expect(await reader.exited).toBe(0)
    expect(saved).toEqual({ open: true, width: 612, tabs: ['activity', 'explorer'], tab: 'explorer', instant: false })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
