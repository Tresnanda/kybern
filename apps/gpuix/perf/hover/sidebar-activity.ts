// Visual-only coverage of the parent's activity-strip change using its existing
// in-memory process-task fixture. This does not start a provider turn or process.
import '../../src/native/local-build.ts'
import assert from 'node:assert/strict'
import {mkdirSync,writeFileSync} from 'node:fs'
import path from 'node:path'
import {launchFixture} from '../../scripts/idle-harness.ts'
import {requireScreen} from '../bench/screen-state.ts'
import {waitForWindowOnscreen,requireWindowOnscreen} from '../bench/window-onscreen.ts'
const root='/Users/mymac/projects/ade/previews/gpuix/sidebar-fix/activity-strip'
mkdirSync(root,{recursive:true})
for(const theme of ['dark','light']){
 requireScreen()
 const scratch=`/Users/mymac/projects/ade-gpuix-scratch/sidebar-fix-activity-${theme}`
 const f=await launchFixture(path.resolve('src/requests/parity.fixture.tsx'),{GPUIX_BACKGROUND:'1',KYBERN_DATA_DIR:scratch,KYBERN_CLIENT_CONFIG_DIR:`${scratch}/client`,KYBERN_GPUIX_CREDENTIALS_DIR:`${scratch}/credentials`,KYBERN_APPEARANCE:theme,KYBERN_URL:'',KYBERN_TOKEN:''})
 try{
  const a=f.app
  await a.getByTestId('fixture-ready').waitFor();await waitForWindowOnscreen(f.pid)
  await a.getByTestId('fixture-activity').click()
  await a.getByTestId('runtime-activity-panel').waitFor();await Bun.sleep(500)
  const text=await a.getByTestId('runtime-activity-panel').textContent()
  assert.match(text,/1 background task/);assert.match(text,/Running focused checks/);assert.match(text,/View activity/)
  requireScreen();requireWindowOnscreen(f.pid)
  await a.screenshot({path:`${root}/${theme}.png`})
  writeFileSync(`${root}/${theme}.json`,JSON.stringify({theme,fixture:'in-memory process-task fixture; no provider run',text},null,2))
 }finally{await f.close()}
}
