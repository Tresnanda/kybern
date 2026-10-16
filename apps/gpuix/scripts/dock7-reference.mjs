// Desktop frontend in WebKit (Tauri webview engine), not the Tauri window.
// Native and browser clocks are separate. These strips pause both the browser
// rAF clock and WAAPI effects, then sample the same requested elapsed times.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { screens } from '../visual/screens/dock7.tauri.mjs'
const { webkit } = await import(process.env.PLAYWRIGHT_CORE ?? '/Users/mymac/projects/component-kit/node_modules/playwright-core/index.mjs')
const data = '/Users/mymac/projects/ade-gpuix-scratch/round7-dock'
const out = '/Users/mymac/projects/ade/previews/gpuix/round7/dock'
const token = readFileSync(`${data}/daemon.token`, 'utf8').trim()
const vite = JSON.parse(readFileSync(`${data}/visual/state.json`, 'utf8')).vitePort
const browser = await webkit.launch()
try {
for (const theme of ['dark', 'light']) for (const reduced of [false, true]) {
  const label = `${theme}-${reduced ? 'reduced' : 'normal'}`
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2, colorScheme: theme, reducedMotion: reduced ? 'reduce' : 'no-preference' })
  const page = await context.newPage()
  // Install before Motion imports/captures rAF; installing after boot leaves
  // its layout projection on the original clock and freezes sibling glides.
  await page.clock.install()
  await page.goto(`http://127.0.0.1:${vite}/?url=ws://127.0.0.1:4273/ws&token=${token}`)
  await page.getByRole('button', { name: 'Notes', exact: true }).first().waitFor()
  await page.addStyleTag({ content: '*::-webkit-scrollbar{display:none}' })
  await screens['dock7-explorer'](page)
  await page.waitForFunction(() => Math.abs([...document.querySelectorAll('[role="treeitem"]')].find(row => row.textContent.trim() === 'README.md').getBoundingClientRect().y - 484) < 1)
  await page.screenshot({ path: `${out}/explorer-nested-${label}-webkit.png` })
  const src = page.getByRole('treeitem', { name: 'src', exact: true })
  await src.click()
  await page.getByRole('treeitem', { name: 'components', exact: true }).waitFor({state:'detached'})
  await page.waitForFunction(() => Math.abs([...document.querySelectorAll('[role="treeitem"]')].find(row => row.textContent.trim() === 'README.md').getBoundingClientRect().y - 252) < 1)
  await page.clock.pauseAt(Date.now() + 50)
  for (const action of ['expand', 'collapse']) {
    const dir = `${out}/${label}-${action}-webkit`; mkdirSync(dir, { recursive: true })
    await src.click({ force: true })
    await page.clock.runFor(1)
    const animations = await page.evaluate(() => {
      window.__treeAnimations = document.getAnimations().filter(animation => animation.effect?.target?.closest?.('[role="tree"]'))
      for (const animation of window.__treeAnimations) animation.pause()
      return window.__treeAnimations.map(animation=>({keyframes:animation.effect.getKeyframes(),timing:animation.effect.getTiming()}))
    })
    let previous = 0
    const samples = []
    for (const time of [0,16,32,64,96,128,176,224,320,600]) {
      await page.clock.runFor(time - previous); previous = time
      await page.evaluate(time => {
        for (const animation of document.getAnimations().filter(animation => animation.effect?.target?.closest?.('[role="tree"]'))) {
          if (!window.__treeAnimations.includes(animation)) window.__treeAnimations.push(animation)
        }
        for (const animation of window.__treeAnimations) { animation.pause(); animation.currentTime = time }
      }, time)
      samples.push({ time, sibling:await page.getByRole('treeitem',{name:'README.md',exact:true}).boundingBox() })
      await page.screenshot({ path: `${dir}/${String(time).padStart(3,'0')}.png` })
    }
    writeFileSync(`${dir}/bounds.json`, JSON.stringify({samples,animations},null,2))
    if (!reduced && Math.abs(samples[0].sibling.y - samples.at(-1).sibling.y) < 150) throw Error(`${label} ${action}: reference did not contain actual layout motion`)
    await page.evaluate(() => { for (const animation of window.__treeAnimations) animation.finish() })
    await page.clock.runFor(600)
  }
  await context.close()
  // Live rAF timing uses a separate context with no clock mocking.
  const live = await browser.newContext({ viewport: { width: 1280, height: 820 }, colorScheme: theme, reducedMotion: reduced ? 'reduce' : 'no-preference' })
  const livePage = await live.newPage()
  await livePage.goto(`http://127.0.0.1:${vite}/?url=ws://127.0.0.1:4273/ws&token=${token}`)
  await livePage.getByRole('button', { name: 'Notes', exact: true }).first().waitFor()
  await screens['dock7-explorer'](livePage)
  const liveSrc = livePage.getByRole('treeitem', { name: 'src', exact: true })
  const pacingPromise = livePage.evaluate(async () => {
    const times = []; const end = performance.now() + 700
    await new Promise(resolve => { const tick = time => { times.push(time); if(time < end) requestAnimationFrame(tick); else resolve() }; requestAnimationFrame(tick) })
    const intervals = times.slice(1).map((time,index)=>time-times[index]).sort((a,b)=>a-b)
    return { frames:times.length,p50:intervals[Math.floor(intervals.length*.5)],p95:intervals[Math.floor(intervals.length*.95)],clock:'live browser rAF, no mocked clock' }
  })
  await liveSrc.click(); await livePage.getByRole('treeitem', { name: 'components', exact: true }).waitFor({state:'detached'})
  await liveSrc.click(); await livePage.getByRole('treeitem', { name: 'components', exact: true }).waitFor()
  const pacing = await pacingPromise
  writeFileSync(`${out}/pacing-${label}-webkit.json`, JSON.stringify(pacing, null, 2))
  console.log('PASS desktop WebKit four-mode strips', label, pacing)
  await live.close()
}
} finally { await browser.close() }
