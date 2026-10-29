// Tree connectors paint at rest at every display scale (`lines-lab.tsx`). Before, each stem and tick was a 0.5 px fill:
// GPUI snaps a fill's edges to device pixels one by one, so on a 1x display (or 1.25x/1.5x) the stems vanished wherever
// they landed on a half pixel and only the last child's elbow (a border) was left. The lab's `fill-*` groups still paint
// that way, as the control.
//
//   bun src/tree/verify.lines.ts [1x|2x]...   (default: both; KYBERN_VERIFY_OUTPUT=<dir> for the screenshots)
//
// 2x runs on the hidden 2x test display (`perf/test-display`); 1x starts the same display with hiDPI off, for this run.
import '../native/local-build.ts'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pngPixels } from '../../native/clip-pixels.ts'
import { ensureTestDisplay, waitForQuiet } from '../../perf/glass/harness.ts'
import { launchFixture } from '../requests/harness.ts'

const GPUIX = path.resolve(import.meta.dir, '../..')
const OUT = process.env.KYBERN_VERIFY_OUTPUT ?? path.join(tmpdir(), 'kybern-tree-lines')
mkdirSync(OUT, { recursive: true })
const MARKER = '/tmp/kybern-gpuix-test-display'
// `lines-lab.tsx`
const OFFSETS = [0, 0.25, 0.5, 0.75], ROW = 24, STEM_X = 8, TICK_END = 20, CHILDREN = 6, WIDTH = 640

/** The test display at 1x: the 2x source with hiDPI off. Gone when this run ends. */
async function lowDensityDisplay(): Promise<() => void> {
  if (existsSync(MARKER)) throw Error('A test display is already up (another check is running); run 1x on its own.')
  const dir = path.join(tmpdir(), 'kybern-tree-lines-display')
  mkdirSync(dir, { recursive: true })
  const source = path.join(dir, 'main.m'), bin = path.join(dir, 'display')
  writeFileSync(source, readFileSync(path.join(GPUIX, 'perf/test-display/main.m'), 'utf8').replace('s.hiDPI = 1;', 's.hiDPI = 0;')
    // Its own serial: WindowServer remembers a display's mode by identity, and the shared 2x display must stay 2x.
    .replace('d.serialNum = 0x0001;', 'd.serialNum = 0x0011;'))
  execFileSync('clang', ['-fobjc-arc', '-framework', 'Foundation', '-framework', 'CoreGraphics', source, '-o', bin])
  const child = spawn(bin, [], { stdio: 'ignore' })
  const deadline = Date.now() + 10_000
  while (!existsSync(MARKER)) { if (child.exitCode !== null || Date.now() > deadline) throw Error('The 1x test display did not start'); await Bun.sleep(50) }
  await Bun.sleep(1500)
  return () => { child.kill('SIGTERM'); Bun.sleepSync(300) }
}

type Px = ReturnType<typeof pngPixels>
/** Whether any device pixel in the logical rect differs from the background by more than a faint tint. */
function inked(px: Px, scale: number, bg: number[], x0: number, x1: number, y0: number, y1: number): boolean {
  for (let y = Math.floor(y0 * scale); y < Math.ceil(y1 * scale); y++)
    for (let x = Math.floor(x0 * scale); x < Math.ceil(x1 * scale); x++) {
      const p = px.at(x, y)
      if (p.reduce((s, v, i) => s + Math.abs(v - bg[i]!), 0) > 18) return true
    }
  return false
}

/** Which connectors of a group painted: the parent's stem, each child's stem slice above its tick, each tick. */
function connectors(px: Px, scale: number, bg: number[], b: { x: number; y: number }, count: number) {
  // Stems: the device pixels around x = STEM_X (the line covers [x - 0.5, x]); ticks around each row's anchor.
  const stem = (y0: number, y1: number) => inked(px, scale, bg, b.x + STEM_X - 1.25, b.x + STEM_X + 0.75, b.y + y0, b.y + y1)
  const tick = (row: number) => inked(px, scale, bg, b.x + STEM_X + 5, b.x + TICK_END - 3, b.y + row + ROW / 2 - 1.25, b.y + row + ROW / 2 + 0.75)
  const out = { parent: stem(ROW / 2 + 10, ROW - 1), stems: [] as boolean[], ticks: [] as boolean[] }
  for (let i = 0; i < count; i++) {
    const row = ROW * (i + 1)
    out.stems.push(stem(row + 1, row + ROW / 2 - 7))
    if (i < count - 1) out.ticks.push(tick(row))
  }
  return out
}

for (const density of (process.argv.slice(2).length ? process.argv.slice(2) : ['2x', '1x'])) {
  if (!(await waitForQuiet())) throw Error('Another agent\'s native build or check is still running after 20 minutes.')
  const stop = density === '1x' ? await lowDensityDisplay() : await ensureTestDisplay(path.join(tmpdir(), 'kybern-tree-lines-display'))
  try {
    for (const theme of ['dark', 'light']) {
      const f = await launchFixture(path.join(import.meta.dir, 'lines-lab.tsx'), { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: theme, KYBERN_DATA_DIR: path.join(tmpdir(), 'kybern-tree-lines-data') })
      try {
        const a = f.app
        await a.getByTestId('ready').waitFor({ timeoutMs: 30_000 })
        await a.getByTestId('open').click()
        await a.getByTestId('go').click()
        // Every draw-in (open stagger, live arrivals 65 ms apart over 480 ms) is long done.
        await Bun.sleep(2500)
        const file = path.join(OUT, `lines-${density}-${theme}.png`)
        await a.screenshot({ path: file })
        const px = pngPixels(file), scale = px.width / WIDTH
        assert.ok(Math.abs(scale - (density === '1x' ? 1 : 2)) < 0.01, `rendered at ${density} (scale ${scale})`)
        const ready = await a.getByTestId('ready').bounds()
        const bg = px.at((ready.x + WIDTH - 8) * scale, (ready.y + 8) * scale)
        const report: Record<string, unknown> = {}
        for (const id of [...OFFSETS.map((_, i) => `tree-${i}`), ...OFFSETS.map((_, i) => `fixed-${i}`), 'opening', 'arriving', ...OFFSETS.map((_, i) => `fill-${i}`)]) {
          const c = connectors(px, scale, bg, await a.getByTestId(id).bounds(), CHILDREN)
          report[id] = c
          if (id.startsWith('fill-')) continue
          assert.ok(c.parent && c.stems.every(Boolean) && c.ticks.every(Boolean), `${density} ${theme} ${id}: every stem and tick paints at rest ${JSON.stringify(c)}`)
        }
        // The control shows the mechanism: at 1x some half-pixel fills round to nothing.
        const fills = OFFSETS.map((_, i) => report[`fill-${i}`] as ReturnType<typeof connectors>)
        const lost = fills.some(c => !c.parent || !c.stems.every(Boolean) || !c.ticks.every(Boolean))
        writeFileSync(path.join(OUT, `lines-${density}-${theme}.json`), JSON.stringify(report, null, 1))
        if (density === '1x') assert.ok(lost, 'the 0.5 px fill control loses lines at 1x (the bug this guards)')
        // At 2x the borders paint exactly the device pixels the fills did: no visual change where it worked.
        if (density === '2x') for (let i = 0; i < OFFSETS.length; i++) {
          const tree = await a.getByTestId(`tree-${i}`).bounds(), fill = await a.getByTestId(`fill-${i}`).bounds()
          let diff = 0
          for (let y = ROW * scale; y < ROW * (CHILDREN + 1) * scale; y++) for (let x = 0; x < TICK_END * scale; x++) {
            const p = px.at(tree.x * scale + x, tree.y * scale + y), q = px.at(fill.x * scale + x, fill.y * scale + y)
            if (p.some((v, k) => Math.abs(v - q[k]!) > 2)) diff++
          }
          assert.equal(diff, 0, `2x ${theme} offset ${OFFSETS[i]}: the connectors match the 0.5 px fills pixel for pixel`)
        }
        console.log(`PASS ${density} ${theme}: TreeLines stems and ticks paint at rest at every offset, in sidebar-style fixed rows, after an open and live arrivals (0.5 px fill control ${lost ? 'loses lines' : 'paints'})`)
      } catch (error) { console.log(f.diagnostics().slice(-2000)); throw error } finally { await f.close() }
    }
  } finally { stop() }
}
process.exit(0)
