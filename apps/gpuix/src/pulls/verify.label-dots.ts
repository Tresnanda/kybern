/**
 * Label chips' colour dots sit on the optical centre of their text (the middle of its x-height), not on the middle of the
 * line box: in the Issues list rows (12 px) and the issue sidebar's chips (12 px, medium), dark and light. Measured on screen:
 * the dot's bounds against the x-height band of the label's own pixels. Mock RPC only. `--light` for the light theme;
 * `KYBERN_VERIFY_OUTPUT=<dir>` saves the window and a zoomed crop of each kind of chip.
 */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { deflateSync } from 'node:zlib'
import { pixels } from '../../native/png.ts'
import { launchFixture } from '../requests/harness.ts'
import { actionFixture } from './verify.fixture.ts'

const mode = process.argv.includes('--light') ? 'light' : 'dark'
const out = process.env.KYBERN_VERIFY_OUTPUT ?? path.join(process.env.TEMP ?? '/tmp', 'kybern-label-dots')
mkdirSync(out, { recursive: true })
const WIDTH = 1280
const fixture = actionFixture()
const f = await launchFixture(path.join(import.meta.dir, '../main.tsx'), { KYBERN_WINDOW_SIZE: `${WIDTH}x820`, ...fixture.env, KYBERN_APPEARANCE: mode })
const a = f.app
const click = async (id: string) => { await a.getByTestId(id).waitFor({ timeoutMs: 10000 }); await a.getByTestId(id).click(); await Bun.sleep(450) }

type Image = ReturnType<typeof pixels>
type Box = { x: number; y: number; width: number; height: number }

/** Where the text after a dot has its x-height, in window points: the rows inked across at least half the busiest row. */
function textCentre(im: Image, scale: number, dot: Box): { centre: number; band: [number, number] } | null {
  const x0 = Math.round((dot.x + dot.width + 3) * scale), x1 = x0 + Math.round(18 * scale)
  const mid = (dot.y + dot.height / 2) * scale
  const y0 = Math.floor(mid - 11 * scale), y1 = Math.ceil(mid + 11 * scale)
  // Ink per row: each pixel's distance from the row's background (the chip's own fill, just right of the dot), so an
  // anti-aliased edge row counts for the part of it the glyphs cover.
  const diffs: number[][] = []
  for (let y = y0; y <= y1; y++) {
    const bg = im.at(Math.round((dot.x + dot.width + 1.5) * scale), y)
    const row: number[] = []
    for (let x = x0; x < x1; x++) row.push(Math.max(...im.at(x, y).map((c, i) => Math.abs(c - bg[i]!))))
    diffs.push(row)
  }
  const full = Math.max(...diffs.flat())
  // Covered (the row's hover card) or cut off at the window's edge: not measurable here.
  if (full < 60) return null
  const ink = diffs.map(row => row.reduce((sum, d) => sum + Math.min(1, d / full), 0))
  const max = Math.max(...ink)
  const band = ink.map((n, i) => n >= max / 2 ? i : -1).filter(i => i >= 0)
  const first = band[0]!, last = band.at(-1)!
  // The x-height's edges fall inside the rows just outside the band, by how much of those rows is inked.
  const top = y0 + first - Math.min(0.5, (ink[first - 1] ?? 0) / max), bottom = y0 + last + 1 + Math.min(0.5, (ink[last + 1] ?? 0) / max)
  return { centre: (top + bottom) / 2 / scale, band: [top / scale, bottom / scale] }
}

/** A crop of the window at 4×, nearest neighbour, as an RGB PNG. */
function zoomed(im: Image, box: Box, scale: number, file: string) {
  const z = 4, sx = Math.round(box.x * scale), sy = Math.round(box.y * scale), w = Math.round(box.width * scale), h = Math.round(box.height * scale)
  const rows: Buffer[] = []
  for (let y = 0; y < h * z; y++) {
    const line = Buffer.alloc(1 + w * z * 3)
    for (let x = 0; x < w * z; x++) { const p = im.at(sx + Math.floor(x / z), sy + Math.floor(y / z)); line.set(p, 1 + x * 3) }
    rows.push(line)
  }
  const chunk = (kind: string, data: Buffer) => { const head = Buffer.alloc(8); head.writeUInt32BE(data.length); head.write(kind, 4, 'ascii'); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(kind, 'ascii'), data]))); return Buffer.concat([head, data, crc]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w * z, 0); ihdr.writeUInt32BE(h * z, 4); ihdr[8] = 8; ihdr[9] = 2
  writeFileSync(file, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]))
}
function crc32(buf: Buffer) { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)) } return ~c >>> 0 }

try {
  await a.getByTestId('app-ready').waitFor({ timeoutMs: 60000 })
  await click('rail-pulls')
  await click('pulls-tab-issues')
  await click('issue-row-228')
  await a.getByTestId('issue-labels').waitFor({ timeoutMs: 10000 })
  await Bun.sleep(800)
  const file = `${out}/label-dots-${mode}.png`
  await a.screenshot({ path: file })
  const im = pixels(file), scale = im.w / WIDTH
  const dots = (await a.getByTestId('label-dot').all()).filter(n => n.bounds).map(n => n.bounds!).filter(b => b.y + 20 < 820)
  const sidebar = await a.getByTestId('issue-labels').bounds()
  const inSidebar = (b: Box) => b.x >= sidebar.x && b.y >= sidebar.y && b.y <= sidebar.y + sidebar.height
  const chips = dots.filter(inSidebar), rows = dots.filter(b => !inSidebar(b))
  assert.ok(chips.length >= 2 && rows.length >= 4, `dots in the sidebar chips (${chips.length}) and the list rows (${rows.length})`)
  const report: string[] = [], misses: number[] = []
  for (const [kind, list] of [['chip', chips], ['row', rows]] as const) {
    for (const dot of list) {
      assert.ok(Math.abs(dot.width - 7) < 0.01 && Math.abs(dot.height - 7) < 0.01, `a ${kind} dot is 7 × 7 (${dot.width} × ${dot.height})`)
      const text = textCentre(im, scale, dot)
      if (!text) continue
      const centre = dot.y + dot.height / 2
      report.push(`${kind} dot ${centre.toFixed(2)} text x-height ${text.band.map(v => v.toFixed(2)).join('–')} centre ${text.centre.toFixed(2)} off ${(centre - text.centre).toFixed(2)}`)
      misses.push(Math.abs(centre - text.centre))
    }
  }
  zoomed(im, { x: chips[0]!.x - 10, y: chips[0]!.y - 10, width: 130, height: 27 }, scale, `${out}/label-dot-chip-${mode}.png`)
  zoomed(im, { x: rows[0]!.x - 6, y: rows[0]!.y - 8, width: 150, height: 23 }, scale, `${out}/label-dot-row-${mode}.png`)
  console.log(report.join('\n'))
  assert.ok(report.filter(r => r.startsWith('chip')).length >= 2 && report.filter(r => r.startsWith('row')).length >= 4, 'enough dots were measured')
  assert.ok(misses.every(miss => miss <= 0.5), "every dot is within 0.5 pt of its text's x-height centre")
  console.log(`PASS ${mode}: label dots sit on their text's x-height centre`)
} finally {
  await f.close()
  fixture.close()
}
process.exit(0)
