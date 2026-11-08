import '../src/native/local-build.ts'
// Interface zoom (#292) on the zoom lab (zoom-lab.tsx), at 100 % → 150 % → 80 %:
//   - the viewport is the window's content size ÷ zoom, and a layout observer (what a terminal sizes its PTY from)
//     reports content pixels;
//   - the frame renders at the display scale × zoom: a 1 px border is scale × zoom device pixels of solid colour, not a
//     stretched, blurred line;
//   - macOS: AppKit pointer events at window points (zoom-input.m) hover, click, scroll and select the element under
//     them at every zoom (the platform → content conversion in GPUI's `on_input`);
//   - a popover anchored under its trigger stays under it;
//   - macOS: a web page placed over its slot covers it and is zoomed like a browser page (a 100 CSS px box is 100
//     content px wide), seen on a capture of the real window;
//   - the window's minimum size is 900×600 × zoom in OS points and the window grows to it;
//   - zooming in stops at the largest step that fits the display, and zooming out at 80 %.
// Off macOS the AppKit and web view parts are skipped; the rest runs through the addon's automation and screenshots.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { COMPANION_CFLAGS } from '../scripts/companion-flags.ts'
import { capture, launch, outputDir, platform, pngPixels, settled, step, tolerance } from './check-harness.ts'
import { fittingZoom, minWindowSize } from '../src/shell/uiZoom.ts'

const out = outputDir('zoom-check')
const mac = platform === 'macos'
if (mac) execFileSync('clang', ['-dynamiclib', ...COMPANION_CFLAGS, '-framework', 'Cocoa', path.join(import.meta.dir, 'zoom-input.m'), '-o', path.join(import.meta.dir, 'build/zoom-input.dylib')])

// The page placed in the lab's web slot: magenta, with a 100 CSS px green box on the left.
const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('<!doctype html><style>html,body{margin:0;height:100%;background:#ff00ff}div{width:100px;height:100%;background:#00ff00}</style><div></div>', { headers: { 'content-type': 'text/html' } }) })
const theme = process.env.KYBERN_APPEARANCE === 'light' ? 'light' : 'dark'
const f = await launch(path.join(import.meta.dir, 'zoom-lab.tsx'), {
  KYBERN_CLIENT_CONFIG_DIR: process.env.KYBERN_CLIENT_CONFIG_DIR ?? mkdtempSync(path.join(tmpdir(), 'kybern-zoom-config-')),
  KYBERN_APPEARANCE: theme,
  KYBERN_ZOOM_LAB_URL: mac ? `http://127.0.0.1:${server.port}/` : '',
  ...(mac ? {} : { KYBERN_ZOOM_LAB_NO_INPUT: '1' }),
})
const a = f.app
type Result = { zoom: number; display: { width: number; height: number } | null; sizes: string; hover: string; click: string; observed: number; selected: string }
const report: Record<string, unknown>[] = []
try {
  await a.getByTestId('ready').waitFor({ timeoutMs: 30_000 })
  const root = (await a.getByTestId('ready').element()).id
  const send = (key: string) => a.call('keyDown', { elementId: root, key })
  const read = async (): Promise<Result> => {
    const text = await a.getByTestId('result').textContent()
    return text ? JSON.parse(text) : { zoom: -1, display: null, sizes: '0 0 0 0', hover: '', click: '', observed: 0, selected: '' }
  }
  const sizes = (r: Result) => { const [minW, minH, width, height] = r.sizes.split(' ').map(Number); return { minW, minH, width, height } }
  await settled(read, (r) => r.zoom === 1)

  for (const wanted of [1, 1.5, 0.8]) {
    const label = `${Math.round(wanted * 100)}%`
    await send(`zoom:${wanted}`)
    let r = await settled(read, (r) => r.zoom === fittingZoom(wanted, r.display))
    const zoom = r.zoom
    const row: Record<string, unknown> = { wanted, zoom, display: r.display }
    report.push(row)

    await step(`${label} viewport and layout observer in content pixels`, async () => {
      // The observer reports after the frame that laid out the new viewport: wait for it to match the viewport.
      const viewport = async () => ({ r: await read(), ready: await a.getByTestId('ready').bounds() })
      const seen = await settled(viewport, ({ r, ready }) => Math.abs(r.observed - (ready.width - 48)) < 1.5 && (!mac || Math.abs(sizes(r).width / zoom - ready.width) < 1.5))
      r = seen.r
      const ready = seen.ready
      if (mac) {
        const { width, height } = sizes(r)
        assert.ok(Math.abs(ready.width - width / zoom) < 1.5 && Math.abs(ready.height - height / zoom) < 1.5, `viewport ${ready.width}×${ready.height} at ${zoom} in a ${width}×${height} pt window`)
      }
      assert.ok(Math.abs(r.observed - (ready.width - 48)) < 1.5, `layout observer ${r.observed}, viewport ${ready.width}`)
      row.viewport = { width: ready.width, height: ready.height }
    })

    await step(`${label} minimum window ${minWindowSize(zoom).width}×${minWindowSize(zoom).height}`, async () => {
      if (!mac) return
      const s = sizes(await settled(read, (r) => sizes(r).minW === minWindowSize(zoom).width))
      assert.equal(s.minW, minWindowSize(zoom).width)
      assert.equal(s.minH, minWindowSize(zoom).height)
      assert.ok(s.width >= s.minW - 0.5 && s.height >= s.minH - 0.5, `window ${s.width}×${s.height} below its minimum ${s.minW}×${s.minH}`)
      row.window = s
    })

    if (mac) {
      await step(`${label} AppKit hover and click land on the element under them`, async () => {
        await send('reset')
        for (const id of ['b1', 'b4']) {
          await send(`hover:${id}`)
          assert.equal((await settled(read, (r) => r.hover === id)).hover, id, `hover ${id}`)
          await send(`click:${id}`)
          assert.equal((await settled(read, (r) => r.click === id)).click, id, `click ${id}`)
        }
      })
      await step(`${label} AppKit scroll moves content by the delta ÷ zoom`, async () => {
        const before = (await a.getByTestId('item-0').bounds()).y
        await send('scroll:list:60')
        const moved = await settled(async () => before - (await a.getByTestId('item-0').bounds()).y, (d) => Math.abs(d - 60 / zoom) < 2)
        assert.ok(Math.abs(moved - 60 / zoom) < 2, `scrolled ${moved} content px for 60 pt at ${zoom}`)
        await send('scroll:list:n60')
        await settled(async () => (await a.getByTestId('item-0').bounds()).y, (y) => Math.abs(y - before) < 1)
        row.scrolled = moved
      })
      await step(`${label} AppKit drag selects the text under it`, async () => {
        await send('select:prose')
        const selected = (await settled(read, (r) => r.selected.includes('bravo charlie'))).selected
        assert.ok(selected.includes('bravo charlie'), `selected ${JSON.stringify(selected)}`)
        await send('click:b0')
      })
    }

    await step(`${label} popover stays under its trigger`, async () => {
      await send('pop')
      const pop = await settled(() => a.getByTestId('popover').bounds().catch(() => null), (b) => !!b)
      const trigger = await a.getByTestId('pop-trigger').bounds()
      assert.ok(pop && Math.abs(pop.x - trigger.x) < 1 && Math.abs(pop.y - (trigger.y + trigger.height + 4)) < 1, `popover ${JSON.stringify(pop)} trigger ${JSON.stringify(trigger)}`)
      await send('pop')
    })

    await step(`${label} renders at the display scale × zoom (crisp 1 px border)`, async () => {
      const file = await capture(f, path.join(out, `lab-${theme}-${label}.png`))
      const png = pngPixels(file)
      const ready = await a.getByTestId('ready').bounds()
      const device = png.width / ready.width
      const edge = await a.getByTestId('edge').bounds()
      const x = Math.floor((edge.x + edge.width / 2) * device)
      let dark = 0
      // Inside the white box, from its top: the border's rows are black, then white begins (a stretched frame would
      // show grey rows in between).
      let grey = 0
      for (let y = Math.round(edge.y * device); y < Math.round((edge.y + 3) * device); y++) {
        const c = png.at(x, y)
        if (c.every((v) => v < 40)) dark++
        else if (!c.every((v) => v > 215)) grey++
      }
      row.greyRows = grey
      row.devicePerContent = device
      row.borderRows = dark
      if (Number.isInteger(Math.round(device * 100) / 100)) assert.equal(dark, Math.round(device), `a 1 px border is ${dark} device rows at ${device}× (want ${Math.round(device)})`)
      else assert.ok(dark >= 1 && dark + grey <= Math.ceil(device), `a 1 px border is ${dark} black + ${grey} grey device rows at ${device}×`)
      if (Number.isInteger(Math.round(device * 100) / 100)) assert.equal(grey, 0, `${grey} grey rows under a 1 px border at ${device}×`)
    })

    if (mac) {
      await step(`${label} web page covers its slot and zooms with the interface`, async () => {
        await send('front')
        await Bun.sleep(600)
        const file = await capture(f, path.join(out, `lab-${theme}-${label}-window.png`), { webViews: true })
        const png = pngPixels(file)
        const s = sizes(await read())
        const scale = png.width / s.width
        const top = png.height - s.height * scale
        const slot = await a.getByTestId('web-slot').bounds()
        const px = (cx: number, cy: number) => png.at(cx * zoom * scale, top + cy * zoom * scale)
        const mid = slot.y + slot.height / 2
        const green = px(slot.x + 90, mid), magenta = px(slot.x + 110, mid)
        row.web = { green, magenta }
        const is = (c: number[], want: number[]) => c.every((v, i) => Math.abs(v - want[i]!) <= Math.max(tolerance, 24))
        assert.ok(is(green, [0, 255, 0]), `90 content px into the page should be its 100 CSS px box: ${green}`)
        assert.ok(is(magenta, [255, 0, 255]), `110 content px into the page should be past the box: ${magenta}`)
      })
    }
  }

  await step('zooming in stops at the largest size that fits the display, zooming out at 80 %', async () => {
    await send('zoom:1')
    let r = await settled(read, (r) => r.zoom === 1)
    for (let i = 0; i < 10; i++) await send('in')
    r = await settled(read, (r) => r.zoom === fittingZoom(2, r.display))
    assert.equal(r.zoom, fittingZoom(2, r.display), `in ×10 → ${r.zoom} on ${JSON.stringify(r.display)}`)
    for (let i = 0; i < 12; i++) await send('out')
    r = await settled(read, (r) => r.zoom === 0.8)
    assert.equal(r.zoom, 0.8)
    report.push({ largest: fittingZoom(2, r.display), display: r.display })
  })
  console.log('zoom-check: ok')
} finally {
  writeFileSync(path.join(out, 'zoom-check.json'), JSON.stringify(report, null, 2))
  writeFileSync(path.join(out, 'zoom-check.log'), f.diagnostics())
  await f.close()
  server.stop(true)
}
