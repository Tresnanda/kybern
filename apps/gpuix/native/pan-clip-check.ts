// A panned (and zoomed) `paintTransform` stage stays clipped by its `overflow: hidden` viewport, not by that viewport moved
// along with the pan (ADE-71: a tall image in the preview was cut off part way down once it was scrolled). A border-only
// box inside the stage keeps its own narrower clip (GPUI paints its border as four strips).
import '../src/native/local-build.ts'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../src/tasks/round7b-harness.ts'
import { assertNonBlackContent, pngPixels } from './clip-pixels.ts'
const out = process.env.KYBERN_VERIFY_OUTPUT ?? path.join(import.meta.dir, 'build/pan-clip'); mkdirSync(out, { recursive: true })
const scratch = { KYBERN_DATA_DIR: process.env.KYBERN_DATA_DIR ?? '/tmp/kybern-pan-clip', KYBERN_URL: '', KYBERN_TOKEN: '' }
const W = 320, H = 260
const RED = [0xc0, 0x30, 0x30], GREEN = [0x30, 0xa0, 0x40], BLUE = [0x30, 0x50, 0xc0], YELLOW = [0xe0, 0xc0, 0x20], RING = [0xd0, 0x40, 0xd0]
const f = await launchFixture(path.join(import.meta.dir, 'pan-clip-lab.tsx'), { GPUIX_BACKGROUND: '1', ...scratch })
try {
  const a = f.app; await a.getByTestId('app-ready').waitFor()
  await a.call('focus', { elementId: (await a.getByTestId('app-ready').element()).id })
  const view = await a.getByTestId('viewport').bounds()
  const shot = async (state: string) => {
    await a.call('keyDown', { key: state }); await Bun.sleep(400)
    // GPUIX's own capture of the rendered frame: no Screen Recording grant or test display needed.
    const file = path.join(out, `${state}.png`)
    await a.screenshot({ path: file })
    assertNonBlackContent(file, W, H, state)
    const px = pngPixels(file), sc = px.width / W, top = px.height / sc - H
    // A point in viewport coordinates.
    return (x: number, y: number) => px.at((view.x + x) * sc, (view.y + y + top) * sc)
  }
  const is = (got: number[], want: number[], label: string) => assert.ok(got.every((v, i) => Math.abs(v - want[i]!) < 12), `${label}: got rgb(${got}) want rgb(${want})`)
  let at = await shot('z')
  is(at(100, 10), RED, 'rest: top'); is(at(100, 110), RED, 'rest: bottom')
  at = await shot('p')
  // Before the fix the viewport's clip moved up 360 with the stage and nothing was left to paint.
  is(at(100, 4), YELLOW, 'panned: top'); is(at(100, 116), YELLOW, 'panned: bottom'); is(at(30, 60), YELLOW, 'panned: left')
  is(at(62, 60), RING, 'panned: ring border'); is(at(100, 60), YELLOW, 'panned: inside the ring')
  at = await shot('m')
  is(at(100, 30), GREEN, 'half: upper'); is(at(100, 100), BLUE, 'half: lower')
  at = await shot('k')
  is(at(10, 4), YELLOW, 'zoomed: top'); is(at(10, 116), YELLOW, 'zoomed: bottom')
  console.log(`ok pan clip: rest, panned, half and zoomed stages fill their viewport; border-only box keeps its strips (${out})`)
} finally { await f.close() }
