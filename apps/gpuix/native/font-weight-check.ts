// The system UI font renders each CSS weight on SF's `wght` axis like WebKit (font_weight.rs): every ladder line is as wide
// as the desktop frontend in WebKit measures it, and 500 differs from 400 and from 600. Writes ladder screenshots.
//   bun native/font-weight-check.ts            (KYBERN_FONT_WEIGHT_AXIS=0 shows the old matching)
import '../src/native/local-build.ts'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { launchFixture } from '../src/tasks/round7b-harness.ts'
const out = process.env.KYBERN_VERIFY_OUTPUT ?? path.join(import.meta.dir, 'build/font-weight'); mkdirSync(out, { recursive: true })
const WEIGHTS = [400, 500, 510, 590, 600, 650, 700]
// Widths of the same strings in the desktop frontend in WebKit (system-ui), measured by font-weight-webkit.mjs.
const webkit: Record<string, number> = JSON.parse(execFileSync('node', [path.join(import.meta.dir, 'font-weight-webkit.mjs')], { encoding: 'utf8', env: { ...process.env, PLAYWRIGHT_CORE: process.env.PLAYWRIGHT_CORE ?? '/Users/mymac/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs' } }))
for (const theme of ['dark', 'light']) {
  const f = await launchFixture(path.join(import.meta.dir, 'font-weight-lab.tsx'), { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: theme, KYBERN_DATA_DIR: '/Users/mymac/projects/ade-gpuix-scratch/phase2-render9', KYBERN_CLIENT_CONFIG_DIR: '/Users/mymac/projects/ade-gpuix-scratch/phase2-render9-client', KYBERN_URL: '', KYBERN_TOKEN: '' })
  try {
    const a = f.app; await a.getByTestId('app-ready').waitFor(); await a.getByTestId('w-700').waitFor()
    const rows: string[] = []
    for (const kind of ['w', 's']) for (const w of WEIGHTS) {
      const width = (await a.getByTestId(`${kind}-${w}`).bounds()).width, ref = webkit[`${kind}-${w}`]!
      rows.push(`${kind}-${w}: gpuix ${width.toFixed(2)} webkit ${ref.toFixed(2)}`)
      if (process.env.KYBERN_FONT_WEIGHT_AXIS !== '0') assert.ok(Math.abs(width - ref) < 1.0, `${kind}-${w}: ${width} vs WebKit ${ref}`)
    }
    const w = async (n: number) => (await a.getByTestId(`w-${n}`).bounds()).width
    if (process.env.KYBERN_FONT_WEIGHT_AXIS !== '0') assert.ok(await w(500) > await w(400) + 1 && await w(600) > await w(500) + 1, '500 is not between 400 and 600')
    const windowId = execFileSync('swift', [path.join(import.meta.dir, '../src/tasks/round7-window-id.swift'), String(f.pid)], { encoding: 'utf8' }).trim()
    execFileSync('screencapture', ['-x', '-o', '-l', windowId, path.join(out, `ladder-${theme}${process.env.KYBERN_FONT_WEIGHT_AXIS === '0' ? '-old' : ''}.png`)])
    console.log(`ok ${theme}\n  ${rows.join('\n  ')}`)
  } finally { await f.close() }
}
