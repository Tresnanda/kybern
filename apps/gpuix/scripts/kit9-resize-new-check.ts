/**
 * The two resize handles the desktop has and GPUIX lacked: the pull request list column (288-512, default 352, saved) and the
 * Explorer file tree column (176-520, default 240, saved). Drag, clamp at both limits, keyboard steps, double-click reset,
 * persistence. PR list against the in-memory PR fixture; Explorer against the seeded scratch daemon (needs
 * `bun scripts/visual-pair.ts notes-gallery --keep && bun scripts/kit9-seed-threads.ts`).
 *
 *   bun scripts/kit9-resize-new-check.ts [--light] [--reduced]
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../src/requests/harness.ts'
import { guardEnv } from './kit9-lib.ts'
import { actionFixture } from '../src/pulls/verify.fixture.ts'
import { SEEDED, start, waitUntil } from './kit9-lib.ts'
const light = process.argv.includes('--light'), reduced = process.argv.includes('--reduced')
const sleep = (n: number) => new Promise((r) => setTimeout(r, n))

async function drag(app: any, id: string, to: number) {
  const from = await app.getByTestId(id).center()
  await app.mouse.move(from); await sleep(60); await app.mouse.down(from)
  const steps = 12
  for (let i = 1; i <= steps; i++) { await app.mouse.move({ x: from.x + ((to - from.x) * i) / steps, y: from.y }, { pressedButton: 0 }); await sleep(8) }
  await app.mouse.up({ x: to, y: from.y })
  await sleep(120)
}
const handleX = async (app: any, id: string) => (await app.getByTestId(id).bounds()).x + 8

// 1. Pull request list.
{
  const fixture = actionFixture()
  const f = await launchFixture(path.join(import.meta.dir, '../src/main.tsx'), guardEnv({ ...fixture.env, KYBERN_APPEARANCE: light ? 'light' : 'dark', ...(reduced ? { KYBERN_REDUCED_MOTION: '1' } : {}) }))
  const app = f.app
  try {
    await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
    await app.getByTestId('rail-pulls').click()
    await app.getByTestId('pr-list-resize').waitFor({ timeoutMs: 15_000 })
    await sleep(500)
    const x0 = await handleX(app, 'pr-list-resize')
    console.log('PR list handle at', x0)
    await drag(app, 'pr-list-resize', x0 + 90)
    const x1 = await handleX(app, 'pr-list-resize')
    assert(Math.abs(x1 - x0 - 90) <= 2, `drag +90 moved the seam ${x1 - x0}`)
    await drag(app, 'pr-list-resize', x1 + 900)
    const xMax = await handleX(app, 'pr-list-resize')
    assert(Math.abs(xMax - x0 - (512 - 352)) <= 2, `max clamp: seam moved ${xMax - x0}, expected ${512 - 352}`)
    await drag(app, 'pr-list-resize', xMax - 900)
    const xMin = await handleX(app, 'pr-list-resize')
    assert(Math.abs(xMin - x0 - (288 - 352)) <= 2, `min clamp: seam moved ${xMin - x0}, expected ${288 - 352}`)
    await app.getByTestId('pr-list-resize').press('right'); await sleep(100)
    assert(Math.abs((await handleX(app, 'pr-list-resize')) - xMin - 16) <= 1, 'ArrowRight steps 16px')
    await app.getByTestId('pr-list-resize').press('shift-right'); await sleep(100)
    assert(Math.abs((await handleX(app, 'pr-list-resize')) - xMin - 80) <= 1, 'Shift+ArrowRight steps 64px')
    console.log('PASS PR list: drag, clamps at 288/512, keyboard steps')
    const file = path.join(fixture.env.KYBERN_DATA_DIR!, 'gpuix-ui.json')
    const saved = async () => { await sleep(700); return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8'))['kybern.pulls.listWidth'] : undefined }
    assert.equal(await saved(), 368, 'the width after the keyboard steps is saved')
    // Double-click resets (`clickCount >= 2` -> onReset): automation cannot synthesize a native click count, so that path is not exercised here.
    console.log('PASS PR list: width persisted')
  } finally { await f.close(); fixture.close() }
}

// 2. Explorer file tree column (seeded thread; the handle exists whether or not the project has files).
{
  Bun.spawnSync(['rm', '-f', `${SEEDED.dataDir}/gpuix-ui.json`])
  const app = (await start({ light, reduced, seeded: true, env: { KYBERN_GPUIX_THREAD: 'Long review thread' } })) as any
  try {
    await waitUntil(async () => (await app.getByTestId('dock-toggle').count()) > 0, 30_000, 'dock toggle')
    await sleep(1500)
    await app.getByTestId('dock-toggle').hover(); await sleep(150); await app.getByTestId('dock-toggle').click()
    await waitUntil(async () => (await app.getByTestId('dock-add').count()) > 0, 10_000, 'dock add')
    await sleep(600)
    await app.getByTestId('dock-add').hover(); await sleep(150); await app.getByTestId('dock-add').click(); await waitUntil(async () => (await app.getByTestId('dock-add-explorer').count()) > 0, 5000, 'add menu')
    await app.getByTestId('dock-add-explorer').hover(); await sleep(150); await app.getByTestId('dock-add-explorer').click()
    await app.getByTestId('dock-file-tree-resize').waitFor({ timeoutMs: 10_000 })
    await sleep(600)
    const x0 = await handleX(app, 'dock-file-tree-resize')
    await drag(app, 'dock-file-tree-resize', x0 + 60)
    const x1 = await handleX(app, 'dock-file-tree-resize')
    assert(Math.abs(x1 - x0 - 60) <= 2, `Explorer drag +60 moved ${x1 - x0}`)
    await drag(app, 'dock-file-tree-resize', x1 - 600)
    const xMin = await handleX(app, 'dock-file-tree-resize')
    assert(Math.abs(xMin - x0 - (176 - 240)) <= 2, `Explorer min clamp: moved ${xMin - x0}, expected ${176 - 240}`)
    console.log('PASS Explorer tree column: drag and 176px minimum')
  } finally { await app.closeAll() }
}
console.log(`ALL PASS (${light ? 'light' : 'dark'}${reduced ? ', reduced motion' : ''})`)
