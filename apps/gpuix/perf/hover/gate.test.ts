import {test,expect} from 'bun:test'
import {fixtureProxyExempt} from '../bench/process-gate.ts'
test('only verified idle windowless fixture proxies may overlap',()=>{
 const command='bun /Users/example/ade-gpuix/visual/fixture.conversation.ts --proxy {}'
 expect(fixtureProxyExempt(command,0,'')).toBe(true)
 expect(fixtureProxyExempt(command,.9,'')).toBe(true)
 for(const cpu of [1,2,NaN,-1])expect(fixtureProxyExempt(command,cpu,'')).toBe(false)
 expect(fixtureProxyExempt(command,0,'window 42 onscreen=false')).toBe(false)
 expect(fixtureProxyExempt(command,0,null)).toBe(false)
 expect(fixtureProxyExempt(command.replace(' --proxy {}',''),0,'')).toBe(false)
 expect(fixtureProxyExempt('bun /Users/example/ade-gpuix/src/main.tsx',0,'')).toBe(false)
})
