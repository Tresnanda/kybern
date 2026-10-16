import { actionFixture } from '../src/pulls/verify.fixture.ts'
import { pacingLock } from './pacing-lock.ts'
const release=await pacingLock(),fixture=actionFixture({long:true})
try {
  const child=Bun.spawn(['node',new URL('pacing-webkit.mjs',import.meta.url).pathname,...process.argv.slice(2)],{env:{...process.env,...fixture.env},stdout:'inherit',stderr:'inherit'})
  process.exitCode=await child.exited
}finally{fixture.close();release()}
