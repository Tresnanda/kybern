import '../src/native/local-build.ts'
import assert from 'node:assert/strict'
import { writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { launchFixture, waitForPainted } from '../src/requests/harness.ts'

// Exercise the real nested measured-flow path. Count layout calls rather than
// elapsed time, so CPU load cannot turn the regression gate into a flaky test.
for (const [name, source, first] of [
 ['table', '| Name | Value |\n|---|---:|\n' + Array.from({length:1500}, (_, i) => `| Row **${i}** | \`value${i}\` |\n`).join(''), 'Name'],
 ['code', '```typescript\n' + Array.from({length:1500}, (_, i) => `const item${i} = "Unicode 😀é and a long line for horizontal overflow";\n`).join('') + '```', 'item0'],
] as const) {
 if(process.env.MD_COST_CASES&&!process.env.MD_COST_CASES.split(',').includes(name))continue
 const file = path.join(import.meta.dir, 'build', `markdown-cost-${name}.md`)
 writeFileSync(file, source)
 const f = await launchFixture(path.join(import.meta.dir, 'markdown-document-lab.tsx'), {
  GPUIX_BACKGROUND:'1', MD_DOCUMENT:'1', MD_DOC_SOURCE:file,
  KYBERN_FRAME_COSTS:'1', KYBERN_FULL_RATE:'1',
 })
 try {
  await f.app.getByTestId('ready').waitFor()
  await waitForPainted(f.app, first, 60_000)
  await Bun.sleep(100)
  const calls:number[]=[]
  for (let i=0;i<6;i++) {
   if(i===3){
    const before=await f.app.getByTestId('ready').bounds()
    await f.app.getByTestId('ready').press('r');await Bun.sleep(100)
    const after=await f.app.getByTestId('ready').bounds()
    assert.ok(after.width<before.width-100,'A definite width change must resize the real viewport')
   }
   await f.app.mouse.wheel({x:300,y:300},0,-120)
   await Bun.sleep(100)
   const last=[...f.diagnostics().matchAll(/\[kybern-work\] renderMs=[\d.]+ layoutMs=[\d.]+ layoutCalls=(\d+)/g)].at(-1)
   assert.ok(last, 'Native frame cost diagnostics must be present')
   calls.push(Number(last[1]))
  }
  console.log(JSON.stringify({case:name,warmLayoutCalls:calls}))
  assert.ok(calls.every(n=>n<1000), `${name}: warm wheel frames must bound layout to the viewport, got ${calls}`)
 } finally { await f.close();rmSync(file,{force:true}) }
}
