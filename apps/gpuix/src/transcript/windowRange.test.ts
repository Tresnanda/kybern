import {describe,expect,it} from 'bun:test'
import {transcriptWindowRange,transcriptWindowRangeBy} from './windowRange.ts'
describe('transcript mount window',()=>{
 it('bounds mounted bodies independently of history length',()=>{for(const count of [1000,3000,30000]){const r=transcriptWindowRange(Array(count).fill(100),500,0,800,200);expect(r).toEqual({start:498,end:510})}})
 it('includes the visible suffix of a tall partially scrolled row',()=>{expect(transcriptWindowRange([5000,100,100,100],0,4900,800,200).end).toBe(4)})
 it('fills backwards from the native end sentinel',()=>{expect(transcriptWindowRange(Array(100).fill(100),100,0,800,200)).toEqual({start:90,end:100})})
 it('walks zero-height rows without losing the visible content',()=>{expect(transcriptWindowRange([0,0,0,200],0,0,100,0).end).toBe(4)})
 it('keeps a pixel window after prepending shifts the stable anchor',()=>{const heights=Array(3000).fill(100);expect(transcriptWindowRange(heights,2100,20,800,200)).toEqual({start:2098,end:2111})})
})

it('large histories read only the nearby height neighborhood', () => {
  let reads = 0
  const range = transcriptWindowRangeBy(36000, () => { reads++; return 160 }, 18000, 0, 800)
  expect(range.start).toBeLessThan(18000)
  expect(range.end).toBeGreaterThan(18000)
  expect(reads).toBeLessThan(40)
})
