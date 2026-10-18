/** Compare paired sidebar pixels; running glyphs have independent phases. */
import { writeFileSync, existsSync } from 'node:fs'
import { pixels } from '../../native/png.ts'
const out = '/Users/mymac/projects/ade/previews/gpuix/perf/sidebar'
const results: unknown[] = []
for (const theme of ['dark', 'light']) for (const scene of process.argv.includes('--checks') ? ['initial','collapsed','expanded','context'] : ['sidebar','sidebar-menu','sidebar-scrolled']) {
  const variant = process.argv.includes('--checks') ? 'checks' : 'visual'
  const before = `${out}/baseline-${variant}-${theme}-${scene}.png`, after = `${out}/candidate-${variant}-${theme}-${scene}.png`
  if (!existsSync(before) || !existsSync(after)) continue
  const a = pixels(before), b = pixels(after), scale = a.w / 1440
  const crop = [Math.round(52*scale), Math.round(46*scale), Math.round((scene.endsWith('menu')?550:309)*scale), Math.round(892*scale)]
  let changed = 0, maxDelta = 0, total = 0
  for (let y=crop[1]!;y<Math.min(a.h,crop[3]!);y++) for(let x=crop[0]!;x<crop[2]!;x++) {
    const p=a.at(x,y),q=b.at(x,y),delta=Math.max(...p.map((v,i)=>Math.abs(v-q[i]!)))
    if(delta>2)changed++
    maxDelta=Math.max(maxDelta,delta);total++
  }
  results.push({ theme, scene, before, after, width: a.w, height: a.h, crop, changedOver2: changed, total, maxDelta })
}
writeFileSync(`${out}/${process.argv.includes('--checks')?'interaction':'settled'}-pixel-diff.json`, JSON.stringify(results,null,2))
console.log(JSON.stringify(results,null,2))
