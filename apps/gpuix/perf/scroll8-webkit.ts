import {readOnlyPrFixture} from './scroll8-real-fixture.ts'
import { actionFixture } from '../src/pulls/verify.fixture.ts'
import { pacingLock,waitForNativeBuilds } from './scroll8-lock.ts'
await waitForNativeBuilds()
const release=await pacingLock(),fixture=process.env.SCROLL8_REAL==='1'?await readOnlyPrFixture():actionFixture({long:true})
try {
  const child=Bun.spawn(['node',new URL('scroll8-webkit.mjs',import.meta.url).pathname,...process.argv.slice(2)],{env:{...process.env,...fixture.env},stdout:'inherit',stderr:'inherit'})
  process.exitCode=await child.exited
}finally{fixture.close();release()}
