import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdirSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { launchFixture } from '../src/requests/harness.ts'
import { DATA_DIR } from '../visual/fixture.ts'

const out = process.env.KYBERN_VERIFY_OUTPUT!
assert.ok(out, 'Set KYBERN_VERIFY_OUTPUT')
mkdirSync(out, { recursive: true })
const data=process.env.KYBERN_DATA_DIR || DATA_DIR
assert.ok(data.includes('gpuix-scratch'), 'Use a scratch daemon')
const client=mkdtempSync(path.join(tmpdir(),'gpuix-scratch-focus-'))
const f = await launchFixture(path.resolve('src/main.tsx'), {
 GPUIX_BACKGROUND:process.argv.includes('--foreground') ? '0' : '1', KYBERN_DATA_DIR:data, KYBERN_URL:`ws://127.0.0.1:${readFileSync(path.join(data,'daemon.port'),'utf8').trim()}/ws`, KYBERN_TOKEN:readFileSync(path.join(data,'daemon.token'),'utf8').trim(),
 KYBERN_CLIENT_CONFIG_DIR:client, KYBERN_GPUIX_CREDENTIALS_DIR:client,
 KYBERN_APPEARANCE:'dark',
})
try {
 const a=f.app
 await a.getByTestId('app-ready').waitFor({timeoutMs:60000})
 await a.getByTestId('rail-settings').click(); await Bun.sleep(600)
 const field=a.getByTestId('settings-search')
 const bounds=await field.bounds()
 writeFileSync(path.join(out,'bounds.json'),JSON.stringify(bounds))
 const shot=async(name:string)=>{await Bun.sleep(200);console.log(name);await a.screenshot({path:path.join(out,`${name}.png`)})}
 await a.call('blur',{}); await shot('blur-before');
 await field.click();await shot('click');
 await a.call('blur',{});await shot('blur-after-click')
 await a.call('focus',{elementId:(await field.element()).id});await shot('api-focus');
 await a.call('blur',{});await shot('blur-after-api')
 await a.call('focus',{elementId:(await a.getByTestId('settings-back').element()).id})
 await a.getByTestId('settings-back').press('tab');await shot('tab');
 await a.call('blur',{});await shot('blur-after-tab')
 const check=Bun.spawnSync(['swift',path.resolve('visual/focus-pixels.swift'),out],{stdout:'pipe',stderr:'pipe'})
 console.log(check.stdout.toString());writeFileSync(path.join(out,'verification.txt'),check.stdout.toString()+check.stderr.toString())
 assert.equal(check.exitCode,0,check.stderr.toString())
} finally { console.log(f.diagnostics()); await f.close();rmSync(client,{recursive:true,force:true}) }
