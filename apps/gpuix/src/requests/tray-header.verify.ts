// Composer tray review fixes (2026-10-21), on scripts/composer-tray-lab.tsx:
//  - "Stop all" stops without closing the tray (it used to sit inside the toggle, and the click bubbled to it);
//  - the summary and the chevron still toggle.
// Focus reveal of row actions is in ComposerTray.test.tsx: background test windows never become key, so they get no focus events.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchFixture } from './harness.ts'
import { lease } from '../../perf/bench/lease.ts'
const out = process.env.KYBERN_VERIFY_OUTPUT ?? '/Users/mymac/projects/ade/previews/motion/gpuixfix/tray'
mkdirSync(out, { recursive: true })
const release = await lease()
try {
  for (const theme of process.env.TRAY_THEMES?.split(',') ?? ['dark', 'light']) {
    const scratch = mkdtempSync(tmpdir() + '/gpuix-tray-')
    const f = await launchFixture(path.resolve(import.meta.dir, '../../scripts/composer-tray-lab.tsx'), { GPUIX_BACKGROUND: '1', KYBERN_OPAQUE: '1', KYBERN_APPEARANCE: theme, KYBERN_REDUCED_MOTION: '1', KYBERN_DATA_DIR: scratch, KYBERN_CLIENT_CONFIG_DIR: scratch, KYBERN_GPUIX_CREDENTIALS_DIR: scratch, KYBERN_URL: '', KYBERN_TOKEN: '' })
    try {
      const a = f.app
      await a.getByTestId('app-ready').waitFor({ timeoutMs: 30000 })
      await a.call('focus', { elementId: (await a.getByTestId('app-ready').element()).id })
      const open = async () => (await a.getByTestId('composer-tray-body').count()) > 0
      const click = async (id: string) => { const c = await a.getByTestId(id).center(); await a.mouse.move(c); await a.mouse.down(c); await a.mouse.up(c); await Bun.sleep(400) }
      // A second working subagent: "Stop all" shows.
      await a.call('keyDown', { key: 'n' }); await Bun.sleep(600)
      assert.ok(await open(), 'tray starts open')
      await a.getByTestId('subagents-stop-all').waitFor({ timeoutMs: 5000 })
      await a.screenshot({ path: `${out}/${theme}-open.png` })
      await click('subagents-stop-all')
      assert.ok(await open(), '"Stop all" must not close the tray')
      await a.screenshot({ path: `${out}/${theme}-after-stop-all.png` })
      await click('composer-tray-chevron')
      assert.ok(!(await open()), 'the chevron closes the tray')
      await click('composer-tray-toggle')
      assert.ok(await open(), 'the summary opens the tray')
      console.log(`${theme}: Stop all keeps the tray open; chevron and summary toggle`)
    } finally { await f.close(); rmSync(scratch, { recursive: true, force: true }) }
  }
} finally { release() }
process.exit(0)
