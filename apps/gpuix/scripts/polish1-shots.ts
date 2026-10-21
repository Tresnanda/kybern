// Polish round 1 captures against `polish1-seed.ts` (start `composer-tray-seed.ts` with TRAY_SCRATCH, then the seed). One
// window per theme on the hidden test display, a cropped PNG per case:
//   shadow  <thread title>    the composer's top edge and the transcript line above it (`--tray` for the tray thread)
//   marquee <thread title>    the hovered sidebar row, frames on the paused clock while its title pans and returns
//   live    <thread title>    the same hover, as WindowServer presents it (`screencapture -l` in real time, so region
//                             painting and retained updates are what is captured); `--shadow` captures the composer instead
// `--addon <dir>` picks the addon (default: this checkout's build), `--source <commit>` loads Composer.tsx and
// sidebar/motion.tsx from that commit (the before), `--reduced 1` Reduce Motion.
//   bun native/ui-lease.ts polish1 bun scripts/polish1-shots.ts shadow "Shadow short" --tag after [--theme dark|light|both]
import '../src/native/local-build.ts'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { launch } from '@gpuix/react/automation'

const arg = (name: string, fallback: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1]! : fallback)
const [mode, title] = process.argv.slice(2)
if (!mode || !title) throw Error('usage: polish1-shots.ts shadow|marquee <thread title> [--tag t] [--theme dark|light|both] [--addon dir] [--source commit]')
const SCRATCH = process.env.TRAY_SCRATCH ?? '/Users/mymac/projects/ade-gpuix-scratch/polish1'
const ready = JSON.parse(readFileSync(path.join(SCRATCH, 'ready.json'), 'utf8'))
const tag = arg('--tag', 'shot')
const themes = arg('--theme', 'both') === 'both' ? ['dark', 'light'] : [arg('--theme', 'dark')]
const out = arg('--out', '/Users/mymac/projects/ade/previews/polish1')
const addon = path.resolve(arg('--addon', path.resolve(import.meta.dir, '../native/build')), 'gpuix-native.darwin-arm64.node')
const grid = path.join(import.meta.dir, 'render9-grid.swift')
const crop = (file: string, box: { x: number; y: number; width: number; height: number }, frames: string[], cols = frames.length) =>
  execFileSync('swift', [grid, file, String(Math.round(box.x * 2)), String(Math.round(box.y * 2)), String(Math.round(box.width * 2)), String(Math.round(box.height * 2)), String(cols), ...frames])
mkdirSync(out, { recursive: true })
for (const theme of themes) {
  const client = path.join(SCRATCH, `client-${theme}`)
  rmSync(client, { recursive: true, force: true })
  rmSync(path.join(SCRATCH, 'data', 'gpuix-ui.json'), { force: true })
  const source = arg('--source', '')
  const app = await launch({
    command: 'bun', args: [path.resolve(import.meta.dir, source ? 'polish1-app.ts' : '../src/main.tsx')],
    env: {
      GPUIX_BACKGROUND: '1', KYBERN_OPAQUE: '1', KYBERN_APPEARANCE: theme, KYBERN_URL: ready.url, KYBERN_TOKEN: ready.token,
      KYBERN_DATA_DIR: path.join(SCRATCH, 'data'), KYBERN_CLIENT_CONFIG_DIR: client, KYBERN_GPUIX_CREDENTIALS_DIR: path.join(SCRATCH, 'credentials'),
      KYBERN_GPUIX_THREAD: process.argv.includes('--tray') ? ready.title : mode !== 'shadow' && !process.argv.includes('--shadow') ? 'Shadow short' : title, KYBERN_REDUCED_MOTION: arg('--reduced', '0'),
      NAPI_RS_NATIVE_LIBRARY_PATH: addon, KYBERN_GPUIX_RESOURCES: '', KYBERND: '', ...(source ? { POLISH1_SOURCE: source, POLISH1_FILES: arg('--files', 'Composer.tsx,Transcript.tsx,sidebar/motion.tsx') } : {}),
    },
  })
  try {
    await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
    await app.getByTestId('composer').waitFor({ timeoutMs: 30_000 })
    await Bun.sleep(3000)
    // `--scroll <px>`: scroll the transcript up so text passes under the composer card's top edge.
    const scroll = Number(arg('--scroll', '0'))
    if (scroll) { for (let left = Math.abs(scroll); left > 0; left -= 40) await app.getByTestId('transcript-surface').wheel(0, Math.sign(scroll) * Math.min(40, left)); await Bun.sleep(1200) }
    const name = `${mode}-${tag}-${theme}`
    if (mode === 'shadow') {
      const full = path.join(out, `${name}-full.png`)
      await app.screenshot({ path: full })
      const box = await app.getByTestId('composer-overlay').bounds()
      crop(path.join(out, `${name}.png`), { x: box.x - 24, y: box.y - 80, width: box.width + 48, height: box.height + 96 }, [full])
      rmSync(full)
    } else if (mode === 'live') {
      // The window as presented: find it by the app's pid on the test display.
      const pid = Bun.spawnSync(['pgrep', '-n', '-f', `ade-polish1/apps/gpuix/(src/main.tsx|scripts/polish1-app.ts)`]).stdout.toString().trim()
      const id = /window (\d+) onscreen=true scale=2/.exec(Bun.spawnSync(['swift', path.join(import.meta.dir, '../perf/bench/window-onscreen.swift'), pid]).stdout.toString())?.[1]
      if (!id) throw Error('window not on the test display')
      const dir = path.join(out, `${name}-frames`)
      mkdirSync(dir, { recursive: true })
      const shadow = process.argv.includes('--shadow')
      const target = shadow ? await app.getByTestId('composer-overlay').bounds() : await app.getByText(title).bounds()
      const area = shadow ? { x: target.x - 24, y: target.y - 80, width: target.width + 48, height: target.height + 96 } : { x: 0, y: target.y - 8, width: 300, height: target.height + 16 }
      if (!shadow) await app.getByText(title).hover()
      const frames: string[] = []
      const start = Date.now()
      for (const at of shadow ? [0, 400] : [100, 500, 900, 1400, 2000, 2800, 3600, 4600]) {
        await Bun.sleep(Math.max(0, start + at - Date.now()))
        const file = path.join(dir, `t${at}.png`)
        Bun.spawnSync(['screencapture', '-x', '-o', '-l', id, file])
        frames.push(file)
      }
      crop(path.join(out, `${name}.png`), area, frames, 1)
      if (process.argv.includes('--keep')) Bun.spawnSync(['cp', frames[0]!, path.join(out, `${name}-window.png`)])
      rmSync(dir, { recursive: true, force: true })
    } else {
      const row = app.getByText(title)
      const at = await app.clock.pause()
      await row.hover()
      const box = await row.bounds()
      // The row's full width: from the sidebar's left gutter to the list's right edge.
      const area = { x: 0, y: box.y - 8, width: 300, height: box.height + 16 }
      const times = [0, 200, 600, 1200, 2000, 3000, 4500, 6000].map(t => at + t)
      const frames = await app.captureFrames(path.join(out, `${name}-frames`), times)
      crop(path.join(out, `${name}.png`), area, frames, 1)
      // Pointer away: the pan returns and the ellipsis comes back.
      await app.getByTestId('composer').hover()
      const back = await app.clock.pause()
      const returns = await app.captureFrames(path.join(out, `${name}-back-frames`), [back, back + 200, back + 500].map(t => t))
      crop(path.join(out, `${name}-back.png`), area, returns, 1)
      rmSync(path.join(out, `${name}-frames`), { recursive: true, force: true })
      rmSync(path.join(out, `${name}-back-frames`), { recursive: true, force: true })
    }
    console.log(`[polish1] ${name}`)
  } finally { await app.close() }
}
process.exit(0)
