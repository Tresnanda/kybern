import '../src/native/local-build.ts'
import assert from 'node:assert/strict'
import path from 'node:path'
import { launch, capture, outputDir, pngPixels, sample, settled } from './check-harness.ts'

const out = outputDir('diff-scroll')
const f = await launch(path.join(import.meta.dir, 'diff-scroll-check-lab.tsx'), {KYBERN_URL: ''})
try {
  const a = f.app
  await a.getByTestId('ready').waitFor()
  const root = (await a.getByTestId('ready').element()).id
  const key = async (key: string) => { await a.call('keyDown', {elementId: root, key}); await a.clock.fastForward(48); await Bun.sleep(60) }
  const inspect = async () => { await key('i'); return JSON.parse(await a.getByTestId('result').textContent()) }
  const anchor = (actual: number[], expected: number[], label: string) => {
    assert.ok(actual, `${label}: missing live ListState`)
    assert.equal(actual[0], expected[0], `${label}: row index`)
    assert.ok(Math.abs(actual[1]! - expected[1]!) < 0.05, `${label}: ${actual[1]} != ${expected[1]} pixel offset`)
  }
  let state = await settled(inspect, s => s.a && s.b && s.list)
  assert.ok(state.a && state.b && state.list, 'all three list states are registered')
  await key('o'); await key('j'); await key('b'); await key('l')
  state = await inspect()
  anchor(state.a, [320, 7.25], 'cached unified diff')
  anchor(state.b, [640, 3.5], 'independent second diff')
  anchor(state.list, [48, 5.5], 'ordinary virtual list')
  assert.ok(state.events.some((e: any) => e.scrollTop?.[0] === 320 && Math.abs(e.scrollTop[1] - 7.25) < 0.05), 'bounds observer carries exact diff anchor')

  const bounds = await a.getByTestId('diff-a').bounds()
  await a.mouse.wheel({x: bounds.x + 150, y: bounds.y + 100}, 0, -237.5)
  await a.clock.fastForward(64); await key('s'); state = await inspect()
  assert.ok(state.saved[0] > 320, 'real wheel advances the live anchor')
  const saved = state.saved, oldId = state.id
  const before = await capture(f, path.join(out, 'diff-before.png'))
  await key('h'); state = await inspect()
  assert.equal(state.old, null, 'unmount removes the registry entry')
  assert.ok(state.events.some((e: any) => e.rect == null), 'observer reports unmount')
  await key('m'); state = await inspect()
  assert.notEqual(state.id, oldId, 'React remount uses a fresh host ID')
  anchor(state.a, [0, 0], 'fresh diff starts at top')
  await key('r'); state = await inspect(); anchor(state.a, saved, 'restored diff')
  anchor(state.b, [640, 3.5], 'restore leaves second diff unchanged')
  anchor(state.list, [48, 5.5], 'restore leaves ordinary list unchanged')
  console.log(JSON.stringify({savedAnchor: saved, restoredAnchor: state.a, oldId, restoredId: state.id}))
  const after = await capture(f, path.join(out, 'diff-restored.png'))
  const pixelsBefore = pngPixels(before), pixelsAfter = pngPixels(after)
  const scale = pixelsBefore.width / 740
  assert.deepEqual(sample(pixelsAfter, scale, bounds, 1), sample(pixelsBefore, scale, bounds, 1), 'restored diff paints the same pixels at the same location')

  await key('d'); state = await inspect(); anchor(state.a, [410, 9.5], 'queued restore survives patch rebuild')
  await key('c'); state = await inspect(); assert.ok(state.a[0] < 52, 'patch shrink clamps its live anchor')
  await key('e'); state = await inspect(); assert.equal(state.a, null, 'empty diff unregisters its state')
  await key('v'); await key('j'); state = await inspect(); anchor(state.a, [320, 7.25], 'nonempty diff re-registers')
  await key('f'); state = await inspect(); assert.equal(state.a, null, 'flow diff unregisters its state')
  await key('v'); state = await inspect(); anchor(state.a, [0, 0], 'scroll mode starts fresh')

  await key('x'); await key('z'); state = await inspect(); anchor(state.raw, [240, 4.5], 'raw diff ID')
  await key('y'); state = await inspect(); assert.equal(state.raw, null, 'raw ID unmount removes state')
  await key('x'); state = await inspect(); anchor(state.raw, [0, 0], 'reused ID has a fresh state')
  console.log('ok exact diff scroll: cached anchors, fractional wheel/read/restore, observer parity, identical restored pixels, independent lists, patch reset/shrink, empty/flow cleanup, remount/new ID/reused ID')
} catch (error) { console.error(f.diagnostics()); throw error }
finally { await f.close() }
