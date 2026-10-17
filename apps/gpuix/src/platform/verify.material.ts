// Window material, live: Settings › Appearance › "Use translucent surfaces"
// switches the content surfaces to glass without a relaunch; Reduce
// transparency and Increase contrast (changed while running through
// KYBERN_A11Y_FILE, never the user's system settings) turn it back off, and
// contrast gives the workspace card a border. Real window captures
// (`screencapture -l`), so the native vibrancy is included.
//
//   KYBERN_DATA_DIR=<scratch> bun src/platform/verify.material.ts <out-dir> <dark|light> [reduced]
import '../native/local-build.ts'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launch } from '@gpuix/react/automation'
import { pixels } from '../../native/png.ts'
import { until, windowId } from './verify.lib.ts'

const [out = '/tmp/material', theme = 'dark', motion] = process.argv.slice(2)
const mode = `${theme}${motion === 'reduced' ? '-reduced' : ''}`
mkdirSync(out, { recursive: true })
const scratch = mkdtempSync(path.join(tmpdir(), 'kybern-material-'))
const a11y = path.join(scratch, 'a11y.json')
writeFileSync(a11y, '{}')
const app = await launch({ command: 'bun', args: [path.join(import.meta.dir, '../main.tsx')], env: {
  GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: theme, KYBERN_A11Y_FILE: a11y, KYBERN_CLIENT_CONFIG_DIR: path.join(scratch, 'client'),
  KYBERN_REDUCED_MOTION: motion === 'reduced' ? '1' : '0', KYBERN_DEBUG_A11Y: '1',
} })
const { pid } = await app.call('initialize', { protocolVersion: 1, client: 'material-check' }) as { pid: number }
const id = windowId(pid)
const shot = (name: string) => { const file = path.join(out, `${name}-${mode}.png`); execFileSync('screencapture', ['-x', '-o', '-l', String(id), file]); return pixels(file) }
// The settings content surface (right of the 256pt sidebar) and the workspace card's left edge.
const content = (img: ReturnType<typeof pixels>) => img.at(1100 * 2, 700 * 2)
const differs = (a: number[], b: number[], by = 2) => a.some((v, i) => Math.abs(v - b[i]!) > by)
try {
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
  await app.getByTestId('rail-settings').click()
  await app.getByTestId('settings-tab-appearance').click()
  await app.getByTestId('settings-translucency').waitFor({ timeoutMs: 10_000 })
  await Bun.sleep(800)
  const opaque = shot('1-switch-off')
  await app.getByTestId('settings-translucency').click()
  // Live: no relaunch. The content surface lets the native material through.
  const glass = await until(async () => { await Bun.sleep(200); const img = shot('2-translucent'); return differs(content(img), content(opaque)) ? img : null }, 'content turns translucent', 8000)
  console.log('content px off/on:', content(opaque), content(glass))
  writeFileSync(a11y, JSON.stringify({ reduceTransparency: true }))
  const reduced = await until(async () => { await Bun.sleep(300); const img = shot('3-reduce-transparency'); return !differs(content(img), content(opaque), 1) ? img : null }, 'Reduce transparency turns glass off', 8000)
  console.log('reduce transparency px:', content(reduced))
  writeFileSync(a11y, JSON.stringify({ increaseContrast: true }))
  const contrast = await until(async () => { await Bun.sleep(300); const img = shot('4-increase-contrast'); return !differs(content(img), content(opaque), 1) ? img : null }, 'Increase contrast turns glass off', 8000)
  // The card edge becomes --color-border: compare the card's top edge just right of the rail.
  const edge = (img: ReturnType<typeof pixels>) => img.at(400 * 2, 46 * 2 + 0)
  console.log('card edge px normal/contrast:', edge(opaque), edge(contrast))
  writeFileSync(a11y, '{}')
  const back = await until(async () => { await Bun.sleep(300); const img = shot('5-restored'); return differs(content(img), content(opaque)) ? img : null }, 'glass back once the options clear', 8000)
  assert.ok(back)
  await app.getByTestId('settings-translucency').click()
  await until(async () => { await Bun.sleep(200); return !differs(content(shot('6-switch-off-again')), content(opaque), 1) }, 'switch off restores opaque content', 8000)
  console.log(`ok  ${mode}: translucency and accessibility options apply live`)
} finally {
  await app.close()
  rmSync(scratch, { recursive: true, force: true })
}
process.exit(0)
