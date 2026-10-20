// Numbers behind the render9 strips: per frame, the press button's left edge (scale), the pop tile's left edge and
// border brightness, the success glyph's ink, and the drop card's top-border colour, for the desktop row (WebKit)
// and the GPUIX row. `bun scripts/render9-strip-metrics.ts <strip dir>` → metrics.json + a table on stdout.
import { readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pngPixels } from '../native/clip-pixels.ts'
const dir = process.argv[2]!
type Img = ReturnType<typeof pngPixels>
const lum = (p: number[]) => 0.2126 * p[0]! + 0.7152 * p[1]! + 0.0722 * p[2]!
const metric: Record<string, (img: Img, top: number) => number> = {
  // First column (from the left) on the button's middle row that differs from the background.
  press: (img, top) => { const y = (40 + top) * 2, bg = lum(img.at(4, y)); for (let x = 30; x < 200; x++) if (Math.abs(lum(img.at(x, y)) - bg) > 40) return x / 2; return -1 },
  pop: (img, top) => { const y = (118 + top) * 2, bg = lum(img.at(4, y)); for (let x = 30; x < 200; x++) if (Math.abs(lum(img.at(x, y)) - bg) > 4) return x / 2; return -1 },
  success: (img, top) => { let ink = 0; for (let y = (100 + top) * 2; y < (120 + top) * 2; y++) for (let x = 310 * 2; x < 330 * 2; x++) { const p = img.at(x, y); ink = Math.max(ink, p[1]! - p[0]!) } return ink },
  drop: (img, top) => { let best = 0; for (let r = -2; r <= 3; r++) { const p = img.at(480 * 2, (180 + top) * 2 + r); best = Math.max(best, p[2]! - p[0]!) } return best },
}
const scenes: Record<string, string[]> = { press: ['press-rest', 'press-down', 'press-up'], pop: ['pop'], success: ['success'], drop: ['drop-in', 'drop-out'] }
const out: Record<string, { frame: string; webkit: number; gpuix: number }[]> = {}
for (const [scene, prefixes] of Object.entries(scenes)) {
  const files = readdirSync(path.join(dir, 'gpuix')).filter(f => prefixes.some(p => f.startsWith(p + '-') || f === p + '.png')).sort((a, b) => prefixes.findIndex(p => a.startsWith(p)) - prefixes.findIndex(p => b.startsWith(p)) || a.localeCompare(b))
  out[scene] = files.map(f => ({ frame: f.replace('.png', ''), webkit: metric[scene]!(pngPixels(path.join(dir, 'webkit', f)), 0), gpuix: metric[scene]!(pngPixels(path.join(dir, 'gpuix', f)), 32) }))
  console.log(`${scene}\n${out[scene]!.map(r => `  ${r.frame.padEnd(16)} desktop ${String(Math.round(r.webkit * 10) / 10).padStart(6)}  gpuix ${String(Math.round(r.gpuix * 10) / 10).padStart(6)}`).join('\n')}`)
}
writeFileSync(path.join(dir, 'metrics.json'), JSON.stringify(out, null, 2))
