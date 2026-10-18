import assert from 'node:assert/strict'
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {launchFixture} from '../../src/requests/harness.ts'
const out=process.env.KYBERN_VERIFY_OUTPUT!
if(!out)throw Error('Set KYBERN_VERIFY_OUTPUT inside the stream evidence folder')
mkdirSync(out,{recursive:true})
const variant=process.env.STREAM_VARIANT??'after'
for(const theme of ['dark','light'])for(const reduced of ['0','1']){
 const scratch=mkdtempSync(tmpdir()+'/gpuix-perf-stream-verify-')
 const f=await launchFixture(import.meta.dir+'/verify.fixture.tsx',{GPUIX_BACKGROUND:'1',KYBERN_OPAQUE:'1',KYBERN_APPEARANCE:theme,KYBERN_REDUCED_MOTION:reduced,KYBERN_DATA_DIR:scratch,KYBERN_CLIENT_CONFIG_DIR:scratch,KYBERN_GPUIX_CREDENTIALS_DIR:scratch,KYBERN_GPUIX_ENVIRONMENT:'local',KYBERN_URL:'',KYBERN_TOKEN:'',KYBERN_FULL_RATE:'1'})
 try{
  await f.app.getByTestId('stream-verify').waitFor();await Bun.sleep(800)
  await f.app.getByTestId('append').click();await Bun.sleep(1200)
  const live=(await f.app.call('getPaintedText',{})).text.join('\n')
  assert.match(live,/Live formatting/);assert.match(live,/Unicode\s+🌿/)
  await f.app.getByTestId('inspect').click()
  await f.app.screenshot({path:`${out}/${variant}-${theme}-${reduced}-live.png`})
  await f.app.getByTestId('finish').click();await Bun.sleep(1000)
  const painted=(await f.app.call('getPaintedText',{})).text.join('\n')
  for(const value of ['FINAL_UNICODE_🌿_漢字_é','First item','Second item','Paint','Exact','const flower'])assert.ok(painted.includes(value),`Missing formatted ${value}`)
  assert.ok(!painted.includes('**strong**'))
  await f.app.screenshot({path:`${out}/${variant}-${theme}-${reduced}-final.png`})
  await f.app.getByTestId('inspect').click();await Bun.sleep(100)
  const documents=f.diagnostics().match(/\[stream-docs\].*/g)??[]
  if(variant==='after')assert.ok(documents.at(-1)?.includes('"documents":0'),`Live document lease was retained: ${documents.join('; ')}`)
  console.log(`PASS ${variant}/${theme}/${reduced}: formatted live/final Unicode, ${documents.join('; ')}`)
 }finally{await f.close();rmSync(scratch,{recursive:true,force:true})}
}
