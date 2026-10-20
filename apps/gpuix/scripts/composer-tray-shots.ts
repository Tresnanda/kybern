// Real-app captures of the composer tray against `composer-tray-seed.ts` (start it first). One window per theme, the seeded
// running thread open, a cropped PNG of the tray + composer; `--attach 1|3` adds image attachments, `--expand` opens the
// first image attachment in the lightbox, `--collapse` clicks the tray header first.
//   bun native/ui-lease.ts composer-tray bun scripts/composer-tray-shots.ts --tag before [--attach 3] [--theme dark|light|both]
import '../src/native/local-build.ts'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { launch } from '@gpuix/react/automation'

const arg = (name: string, fallback: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1]! : fallback)
const SCRATCH = '/Users/mymac/projects/ade-gpuix-scratch/composer-tray'
const ready = JSON.parse(readFileSync(path.join(SCRATCH, 'ready.json'), 'utf8'))
const tag = arg('--tag', 'shot'), attach = Number(arg('--attach', '0'))
const themes = arg('--theme', 'both') === 'both' ? ['dark', 'light'] : [arg('--theme', 'dark')]
const out = arg('--out', '/Users/mymac/projects/ade/previews/composer-tray')
const IMAGE = path.resolve(import.meta.dir, '../../desktop/public/release-background.png')
const SECOND = path.resolve(import.meta.dir, '../../desktop/src-tauri/icons/128x128@2x.png')
mkdirSync(out, { recursive: true })
for (const theme of themes) {
  const client = path.join(SCRATCH, `client-${theme}`)
  rmSync(client, { recursive: true, force: true })
  // Composer drafts (and their attachments) persist per data dir: start every capture from an empty composer.
  rmSync(path.join(SCRATCH, 'data', 'gpuix-ui.json'), { force: true })
  const app = await launch({
    command: 'bun', args: [path.resolve(import.meta.dir, '../src/main.tsx')],
    env: {
      GPUIX_BACKGROUND: '1', KYBERN_OPAQUE: '1', KYBERN_APPEARANCE: theme, KYBERN_URL: ready.url, KYBERN_TOKEN: ready.token,
      KYBERN_DATA_DIR: path.join(SCRATCH, 'data'), KYBERN_CLIENT_CONFIG_DIR: client, KYBERN_GPUIX_CREDENTIALS_DIR: path.join(SCRATCH, 'credentials'),
      KYBERN_GPUIX_THREAD: ready.title, KYBERN_REDUCED_MOTION: arg('--reduced', '0'),
      NAPI_RS_NATIVE_LIBRARY_PATH: path.resolve(import.meta.dir, '../native/build/gpuix-native.darwin-arm64.node'),
      ...(attach ? { KYBERN_GPUIX_ATTACH: Array.from({ length: attach }, (_, i) => (i % 2 ? SECOND : IMAGE)).join(',') } : {}),
    },
  })
  try {
    await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
    await app.getByTestId('composer').waitFor({ timeoutMs: 30_000 })
    await Bun.sleep(3000)
    if (process.argv.includes('--collapse')) { await app.getByTestId('composer-tray-toggle').click(); await Bun.sleep(600) }
    if (process.argv.includes('--expand')) { await app.getByTestId('attachment-image1').click(); await Bun.sleep(900) }
    const full = path.join(out, `${tag}-${theme}-full.png`)
    await app.screenshot({ path: full })
    const box = await app.getByTestId('composer-overlay').bounds()
    const crop = process.argv.includes('--expand') ? { x: 0, y: 0, w: 0, h: 0 } : attach ? { x: box.x - 16, y: box.y - 60, w: box.width + 32, h: box.height + 76 } : { x: box.x - 16, y: box.y - 300, w: box.width + 32, h: box.height + 316 }
    if (crop.w) execFileSync('swift', [path.join(import.meta.dir, 'render9-grid.swift'), path.join(out, `${tag}-${theme}.png`), String(crop.x * 2), String(Math.max(0, crop.y) * 2), String(crop.w * 2), String((crop.h + Math.min(0, crop.y)) * 2), '1', 'top:0', full])
    console.log(`[tray] ${tag} ${theme}`)
  } finally { await app.close() }
}
process.exit(0)
