import '../src/native/local-build.ts'
import assert from 'node:assert/strict'
import path from 'node:path'
import {launchFixture} from '../src/requests/harness.ts'
const f=await launchFixture(path.join(import.meta.dir,'syntax-lab.tsx'),{GPUIX_BACKGROUND:'1',SYNTAX_LARGE:'1',SYNTAX_START:'69999',SYNTAX_END:'70003'})
try{
 const a=f.app;await a.getByTestId('ready').waitFor()
 const b=await a.getByTestId('ready').bounds();assert.equal(b.height,80)
 const text=(await a.call('getPaintedText',{})).text
 assert.ok(text.length<15,`Large document mounted ${text.length} text runs`)
 assert.ok(text.includes('const end = 1;'));assert.ok(text.includes('70003'))
 console.log('ok 70003-line / >512 KiB document mounts exactly four rows with absolute line numbers')
}catch(e){console.error(f.diagnostics());throw e}finally{await f.close()}
