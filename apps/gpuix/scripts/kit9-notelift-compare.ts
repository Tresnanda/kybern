/**
 * R4-2: build the desktop-vs-GPUIX frame strips and the numeric comparison from the captures of
 * `kit9-notelift-tauri.mjs` and `kit9-notelift.ts` (run both first for the theme).
 *
 *   bun scripts/kit9-notelift-compare.ts dark|light
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
const theme = process.argv[2] ?? 'dark'
const dir = '/Users/mymac/projects/ade/previews/gpuix/phase2/kit9/notelift'
const here = import.meta.dir
const pad = (n: number) => String(n).padStart(3, '0')
const sh = (cmd: string[]) => { const r = Bun.spawnSync(cmd); if (r.exitCode !== 0) throw new Error(`${cmd.join(' ')}: ${r.stderr}`) }
const g140 = JSON.parse(readFileSync(`${dir}/gpuix-${theme}-140ms.json`, 'utf8'))
const tauri = JSON.parse(readFileSync(`${dir}/tauri-${theme}.json`, 'utf8'))
const times = [0, 35, 70, 105, 140, 180]
const gOffsets = [0, 17, 33, 50, 67, 83, 100, 117, 133, 150, 183, 220]
const nearest = (t: number) => gOffsets.reduce((a, b) => (Math.abs(b - t) < Math.abs(a - t) ? b : a))
// Crop the thumb's top-left corner, where a 2px lift is easiest to read: 300 x 64 pt at 2x.
const crop = (src: string, dst: string, x: number, y: number) => sh(['swift', path.join(here, 'kit9-crop.swift'), src, dst, String(x), String(y), '300', '80'])
const rest = g140.rest
const rows: string[] = []
const tauriFiles = times.map((t) => { const f = `${dir}/tauri-${theme}-${pad(Math.min(t, 140))}.png`; const o = `${dir}/c-tauri-${theme}-${pad(t)}.png`; crop(f, o, 0, 0); return o })
rows.push(`desktop-140ms-in-webkit=${tauriFiles.join(',')}`)
for (const ms of [140, 180]) {
  if (!existsSync(`${dir}/gpuix-${theme}-${ms}ms-000.png`)) continue
  const files = times.map((t) => {
    const n = nearest(t)
    const f = `${dir}/gpuix-${theme}-${ms}ms-${pad(n)}.png`
    const o = `${dir}/c-gpuix-${theme}-${ms}ms-${pad(t)}.png`
    crop(f, o, Math.round((rest.x - 16) * 2), Math.round((rest.y - 16) * 2))
    return o
  })
  rows.push(`gpuix-${ms}ms=${files.join(',')}`)
}
sh(['swift', path.join(here, 'kit9-strip.swift'), `${dir}/strip-${theme}.png`, '300', ...rows])
console.log(`wrote ${dir}/strip-${theme}.png`)

// Numbers: the CSS curve (cubic-bezier(0.2, 0, 0, 1) over 140 ms, -2px) against GPUIX's measured top.
const bez = (p1x: number, p1y: number, p2x: number, p2y: number, x: number) => {
  let lo = 0, hi = 1
  for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; const bx = 3 * (1 - m) ** 2 * m * p1x + 3 * (1 - m) * m * m * p2x + m ** 3; if (bx < x) lo = m; else hi = m }
  const m = (lo + hi) / 2
  return 3 * (1 - m) ** 2 * m * p1y + 3 * (1 - m) * m * m * p2y + m ** 3
}
const ideal = (t: number, ms: number) => -2 * bez(0.2, 0, 0, 1, Math.min(1, t / ms))
console.log('offset  ideal(140)  gpuix(140)  [GPUIX bounds snap to 0.5 px]')
for (const o of gOffsets) console.log(String(o).padStart(5), ideal(o, 140).toFixed(2).padStart(10), String(g140.tops[o]).padStart(10))
console.log('desktop live rAF: settled', tauri.settledTy, 'p50', tauri.p50, 'p95', tauri.p95, 'frames', tauri.frames)
console.log('desktop shadow bands (hovered vs rest outside the card):', JSON.stringify(tauri.shadow))
