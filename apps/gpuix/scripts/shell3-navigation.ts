/** Pointer-first regression probe; scratch visual environment only. */
import { OUT, start, waitUntil, exists } from './shell3-lib.ts'
import assert from 'node:assert/strict'
import path from 'node:path'
import { writeFileSync } from 'node:fs'
const { actionFixture } = await import('../src/pulls/verify.fixture.ts')
const fixture = actionFixture()
const before=process.argv.includes('--before')
const light=process.argv.includes('--light')
const app = await start(light, { ...fixture.env, KYBERN_REDUCED_MOTION: '1' })
const click = async (id: string) => { await app.getByTestId(id).hover(); await Bun.sleep(180); await app.getByTestId(id).click() }
try {
  await click('rail-usage')
  await waitUntil(exists(app, 'page-usage'), 8000, 'Usage')
  await app.mouse.move({x:1275,y:815})
  await app.screenshot({path:`${OUT}/usage-${light?'light':'dark'}.png`})
  assert.equal(await app.getByTestId('sidebar-resize').count(),0,'Usage opened the thread sidebar')
  await app.getByTestId('app-ready').press('cmd-b')
  assert.equal(await app.getByTestId('sidebar-resize').count(),0,'Usage keyboard shortcut changed the Home panel')
  await click('rail-home')
  await waitUntil(exists(app,'sidebar-resize'),5000,'Home sidebar preference preserved')
  await click('rail-usage')
  await click('rail-pulls')
  await waitUntil(exists(app, 'pr-row-108'), 12000, 'PR list')
  await click('pr-row-108')
  await click('pr-row-110')
  // Keep selection at 110, then keyboard-focus 109, both visible in the viewport.
  await app.getByTestId('pr-row-110').press('up')
  await app.mouse.move({x:1275,y:815})
  await Bun.sleep(150)
  const tree = await app.call('getTree',{})
  writeFileSync(`${OUT}/pr-${before?'before-':''}${light?'light':'dark'}.json`, JSON.stringify(tree,null,2))
  await app.screenshot({path:`${OUT}/pr-${before?'before-':''}${light?'light':'dark'}.png`})
  console.log('PR 110 selected, 109 focused; captured')
  if(!before && process.env.PLAYWRIGHT_CORE){
    await app.close()
    const reference=Bun.spawn(['node',path.join(import.meta.dir,'shell3-navigation-tauri.mjs'),JSON.stringify({url:fixture.env.KYBERN_URL,theme:light?'light':'dark'})],{stdout:'inherit',stderr:'inherit'})
    if(await reference.exited)throw Error('Tauri navigation reference failed')
    for(const screen of ['usage','pr']){const base=`${OUT}/${screen}-${light?'light':'dark'}`;const pair=Bun.spawn(['swift',path.join(import.meta.dir,'../visual/compose.swift'),`${base}-tauri.png`,`${base}.png`,`${base}-pair.png`,`${base}-diff.png`],{stdout:'inherit',stderr:'inherit'});if(await pair.exited)throw Error('Navigation pair failed')}
  }
} finally { await app.close(); fixture.close() }
