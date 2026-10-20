import '../src/native/local-build.ts'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../scripts/idle-harness.ts'
import { requireScreen } from '../perf/bench/screen-state.ts'
import { waitForWindowOnscreen, requireWindowOnscreen } from '../perf/bench/window-onscreen.ts'

const out = process.env.KYBERN_VERIFY_OUTPUT ?? '/Users/mymac/projects/ade/previews/gpuix/handson-r5/hover'
mkdirSync(out, { recursive: true })
const baseline = process.argv.includes('--baseline'), results: unknown[] = []
for (const theme of ['dark', 'light']) {
  requireScreen()
  const f = await launchFixture(path.join(import.meta.dir, 'hover-lab.tsx'), { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: theme, KYBERN_FRAME_TIMES: '1', KYBERN_CLIENT_CONFIG_DIR: process.env.KYBERN_CLIENT_CONFIG_DIR ?? '/Users/mymac/projects/ade-gpuix-scratch/hr5-hover-lab-client' })
  const a = f.app, checks: Record<string, boolean> = {}
  const read = async (id: string) => (await a.getByTestId(id).textContent()) ?? ''
  const shot = async (label: string) => {
    requireScreen(); requireWindowOnscreen(f.pid)
    // The native screenshot barrier is intentional here: state assertions above
    // establish hover before capture; this is visual evidence, never timing.
    await a.screenshot({ path: `${out}/${baseline ? 'before' : 'after'}-${theme}-${label}.png` })
  }
  try {
    await a.getByTestId('app-ready').waitFor(); await waitForWindowOnscreen(f.pid); await Bun.sleep(500)
    const firstFrame = () => [...f.diagnostics().matchAll(/\[kybern-submit\] ([\d.]+)/g)].at(-1)?.[1]
    const initial=firstFrame();await Bun.sleep(600);checks.idleBeforeMotion=initial===firstFrame()
    const p = await a.getByTestId('row-1').center()
    await a.mouse.move(p); await Bun.sleep(300)
    checks.enter = (await read('row-1')).includes('hover true')
    await a.mouse.wheel(p, 0, -96); await Bun.sleep(500)
    checks.scrollLeave = !(await read('row-1')).includes('hover true')
    const current = await a.getByTestId('row-4').bounds()
    checks.scrollEnter = (await read('row-4')).includes('hover true') && p.y >= current.y && p.y < current.y + current.height
    await shot('scroll')
    await a.mouse.move(await a.getByTestId('row--1').center()); await Bun.sleep(200)
    await a.mouse.down(await a.getByTestId('row--1').center());await Bun.sleep(200)
    checks.pressRetainsHover=(await read('row--1')).includes('hover true')
    await a.mouse.move({x:580,y:620},{pressedButton:0});await a.mouse.up({x:580,y:620})
    await a.mouse.move(await a.getByTestId('row--1').center());await Bun.sleep(200)
    await a.mouse.click(await a.getByTestId('row--1').center()); await Bun.sleep(500)
    checks.reflowLeave = !(await read('row--1')).includes('hover true')
    await shot('controls')
    await a.mouse.move(await a.getByTestId('row--2').center());await Bun.sleep(200)
    await a.mouse.click(await a.getByTestId('row--2').center());await Bun.sleep(500)
    checks.retainedTranslationLeave=!(await read('row--2')).includes('hover true')
    await a.mouse.move(await a.getByTestId('row--3').center());await Bun.sleep(200)
    await a.mouse.click(await a.getByTestId('row--3').center());await Bun.sleep(500)
    checks.retainedTransformLeave=!(await read('row--3')).includes('hover true')
    await shot('retained-motion')
    await a.mouse.move({x:580,y:620});await Bun.sleep(400)
    const settledMotion=firstFrame();await Bun.sleep(600);checks.idleAfterRetainedMotion=settledMotion===firstFrame()
    const prose = await a.getByTestId('prose').bounds()
    await a.mouse.drag({x:prose.x+2,y:prose.y+prose.height/2},{x:prose.x+100,y:prose.y+prose.height/2})
    checks.proseSelection = !!(await a.call('getSelectedText',{})).text
    for(const id of ['document','source']){
      const body=await a.getByTestId(id).bounds()
      await a.mouse.drag({x:body.x+20,y:body.y+body.height/2},{x:body.x+120,y:body.y+body.height/2})
      checks[`${id}Selection`]=!!(await a.call('getSelectedText',{})).text
    }
    await a.mouse.click(await a.getByTestId('row--1').center())
    checks.controlClearsSelection = !(await a.call('getSelectedText',{})).text
    await a.mouse.move({x:580,y:620});await Bun.sleep(2000)
    const frame = () => [...f.diagnostics().matchAll(/\[kybern-submit\] ([\d.]+)/g)].at(-1)?.[1]
    const parked=frame(); await Bun.sleep(1500)
    checks.idleNoFrames=parked===frame()

    results.push({ theme, checks })
    writeFileSync(`${out}/${baseline ? 'before' : 'after'}-native.json`, JSON.stringify(results,null,2))
    if (!baseline) for (const [name, passed] of Object.entries(checks)) assert.ok(passed, `${theme}: ${name}`)
  } finally { writeFileSync(`${out}/${baseline ? 'before' : 'after'}-${theme}-native.log`,f.diagnostics());await f.close() }
}
writeFileSync(`${out}/${baseline ? 'before' : 'after'}-native.json`, JSON.stringify(results, null, 2))
console.log(JSON.stringify(results))
