// Review 2026-10-21: a press on an attachment's × dragged off before release set a flag that only a click cleared, so the
// next click on that tile was swallowed. On scripts/composer-tray-lab.tsx: press × and release elsewhere, then click the
// tile: its preview opens. A click on the other tile's × removes it and opens no preview.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchFixture } from '../requests/harness.ts'
import { lease } from '../../perf/bench/lease.ts'
async function until(check: () => Promise<boolean>, what: string) { for (let i = 0; i < 100; i++) { try { if (await check()) return } catch {} await Bun.sleep(50) } throw Error(`Timed out: ${what}`) }
const out = process.env.KYBERN_VERIFY_OUTPUT ?? '/Users/mymac/projects/ade/previews/motion/gpuixfix/attachments'
mkdirSync(out, { recursive: true })
const release = await lease()
try {
  for (const theme of process.env.PRESS_THEMES?.split(',') ?? ['dark', 'light']) {
    const scratch = mkdtempSync(tmpdir() + '/gpuix-press-')
    const f = await launchFixture(path.resolve(import.meta.dir, '../../scripts/composer-tray-lab.tsx'), { GPUIX_BACKGROUND: '1', KYBERN_OPAQUE: '1', KYBERN_APPEARANCE: theme, KYBERN_REDUCED_MOTION: '1', KYBERN_DATA_DIR: scratch, KYBERN_CLIENT_CONFIG_DIR: scratch, KYBERN_GPUIX_CREDENTIALS_DIR: scratch, KYBERN_URL: '', KYBERN_TOKEN: '' })
    try {
      const a = f.app
      await a.getByTestId('app-ready').waitFor({ timeoutMs: 30000 })
      await Bun.sleep(800)
      const lightbox = async () => (await a.getByTestId('attachment-lightbox').count()) > 0
      const x = await a.getByTestId('remove-attachment-image1').center()
      await a.mouse.move(x); await a.mouse.down(x)
      await a.mouse.move({ x: x.x + 300, y: x.y + 120 }, { pressedButton: 0 }); await a.mouse.up({ x: x.x + 300, y: x.y + 120 })
      await Bun.sleep(300)
      assert.ok((await a.getByTestId('attachment-image1').count()) > 0, 'a press released off the × removes nothing')
      const tile = await a.getByTestId('attachment-image1').bounds()
      await a.mouse.click({ x: tile.x + 16, y: tile.y + tile.height - 12 })
      await until(lightbox, 'the next click on the tile opens its preview')
      await a.screenshot({ path: `${out}/${theme}-preview.png` })
      await a.getByTestId('attachment-lightbox').press('escape')
      await until(async () => !(await lightbox()), 'preview closed')
      await a.mouse.click(await a.getByTestId('remove-attachment-image2').center())
      await until(async () => (await a.getByTestId('attachment-image2').count()) === 0, 'the × removes its tile')
      await Bun.sleep(300)
      assert.ok(!(await lightbox()), 'a click on the × opens no preview')
      console.log(`${theme}: × press released elsewhere leaves the tile clickable; × click removes without a preview`)
    } finally { await f.close(); rmSync(scratch, { recursive: true, force: true }) }
  }
} finally { release() }
process.exit(0)
