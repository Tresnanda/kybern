import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { dockGeometry, restoreDockChoices } from './store.ts'

describe('dock layout and thread choices', () => {
  test('reserves 320px for chat and overlays below 736px of available space', () => {
    expect(dockGeometry(1280, 256, 900)).toEqual({ overlay: false, max: 644, width: 644 })
    expect(dockGeometry(980, 256, 900)).toEqual({ overlay: true, max: 664, width: 664 })
    expect(dockGeometry(980, 0, 200)).toEqual({ overlay: false, max: 600, width: 416 })
  })
  test('closing the active tab chooses its neighbour, then leaves a real empty strip', async () => {
    const result = await isolated(`
      const id = 'dock-test-close'; const states = [];
      setDock(id, { tabs: ['agents', 'changes', 'activity'], tab: 'changes', open: true });
      closeTab(id, 'changes'); states.push(getDock(id).tab);
      closeTab(id, 'activity'); states.push(getDock(id).tab);
      closeTab(id, 'agents'); states.push(getDock(id));
      console.log(JSON.stringify(states));
    `)
    expect(result[0]).toBe('activity')
    expect(result[1]).toBe('agents')
    expect(result[2].tabs).toEqual([])
    expect(result[2].tab).toBeNull()
    expect(result[2].open).toBe(true)
  })
  test('tabs and widths stay with their thread and choosing an open tab never duplicates it', async () => {
    const [a, b] = await isolated(`
      setDock('dock-test-a', { width: 600, open: true });
      chooseTab('dock-test-a', 'explorer'); chooseTab('dock-test-a', 'explorer');
      chooseTab('dock-test-b', 'changes');
      console.log(JSON.stringify([getDock('dock-test-a'), getDock('dock-test-b')]));
    `)
    expect(a.tabs).toEqual(['explorer'])
    expect(a.width).toBe(600)
    expect(b.tabs).toEqual(['changes'])
    expect(b.open).toBe(false)
  })
})

test('restoring dock preferences rejects corrupt values and stale tabs', () => {
  expect(restoreDockChoices({ corrupt: true }).size).toBe(0)
  const restored = restoreDockChoices([null, ['thread', { open: true, tabs: ['agents', 'unknown', 'agents'], tab: 'unknown', width: -5, instant: true }]])
  expect(restored.get('thread')).toEqual({ open: true, tabs: ['agents'], tab: 'agents', width: 416, instant: false })
  // Terminal, preview and review open as tabs beside the chat since ADE-54: saved dock choices drop them.
  expect(restoreDockChoices([['t', { open: true, tabs: ['terminal', 'preview', 'review', 'explorer'], tab: 'terminal' }]]).get('t')).toMatchObject({ tabs: ['explorer'], tab: 'explorer' })
})

// Persistence is part of setDock now: even a bare `bun test` must not save test
// thread IDs into the user's preferences. Each mutation test owns its process.
async function isolated(source: string) {
  const dir = mkdtempSync(path.join(tmpdir(), 'gpuix-scratch-dock-test-'))
  try {
    const child = Bun.spawn(['bun', '-e', `import { setDock, getDock, closeTab, chooseTab } from ${JSON.stringify(path.resolve(import.meta.dir, 'store.ts'))}; ${source}`], { env: { ...process.env, KYBERN_DATA_DIR: dir, KYBERN_CLIENT_CONFIG_DIR: path.join(dir, 'config'), KYBERN_URL: '', KYBERN_TOKEN: '' }, stdout: 'pipe', stderr: 'pipe' })
    const output = await new Response(child.stdout).text()
    expect(await child.exited).toBe(0)
    return JSON.parse(output)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
