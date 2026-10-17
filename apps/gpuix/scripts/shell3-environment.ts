/** Environment panel pointer toggle plus native frame geometry, scratch only. */
import assert from 'node:assert/strict'
import { OUT, startScratch, waitUntil, exists } from './shell3-lib.ts'
import { writeFileSync, mkdirSync } from 'node:fs'
const light = process.argv.includes('--light'), reduced = process.argv.includes('--reduced')
const app = await startScratch({light, thread:'Long review thread',env: reduced ? {KYBERN_REDUCED_MOTION:'1'} : {}})
console.log('launched')
const name=`environment-${light?'light':'dark'}${reduced?'-reduced':''}`
try {
  await waitUntil(exists(app,'environment-toggle'), 15000,'Environment toggle')
  await app.getByTestId('environment-toggle').hover(); await Bun.sleep(200)
  console.log('toggle hovered')
  const at=await app.clock.pause()
  await app.getByTestId('environment-toggle').click()
  console.log('toggle clicked')
  await waitUntil(exists(app,'environment-panel'),10000,'Environment panel')
  const data=[]
  mkdirSync(`${OUT}/${name}`,{recursive:true})
  for(const delta of reduced?[0]:[0,40,80,140,220,320]){
    console.log('frame',delta)
    await app.clock.set(at+delta)
    await app.screenshot({path:`${OUT}/${name}/open-${delta}.png`})
    data.push({delta,panel:await app.getByTestId('environment-panel').bounds(),content:await app.getByTestId('transcript-surface').bounds()})
  }
  if(reduced){assert(Math.abs(data[0]!.content.width-651)<1,'reduced motion inset must settle immediately');assert(Math.abs(data[0]!.panel.x-978.5)<1,'reduced motion panel must not slide')}
  assert(data.at(-1)!.content.width < data[0]!.content.width || reduced, 'content did not animate narrower')
  await app.clock.resume()
  await app.getByTestId('environment-toggle').hover(); await Bun.sleep(200)
  const closeAt=await app.clock.pause()
  await app.getByTestId('environment-toggle').click()
  for(const delta of reduced?[0]:[0,40,80,140,220]){
    await app.clock.set(closeAt+delta)
    await app.screenshot({path:`${OUT}/${name}/close-${delta}.png`})
  }
  await app.clock.resume()
  await waitUntil(async()=>!await exists(app,'environment-panel')(),5000,'panel exit unmount')
  writeFileSync(`${OUT}/${name}.json`,JSON.stringify(data,null,2)); console.log('PASS',name,JSON.stringify(data))
}finally{await app.close()}
