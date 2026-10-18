import {test,expect} from 'bun:test'
import {sparseIndices} from './sparseList.tsx'
test('30,000 logical rows create only a local window and sparse owners',()=>{
  expect(sparseIndices(15000,15040,30000,[2,15020,29999,-1,30000])).toEqual([2,...Array.from({length:40},(_,i)=>15000+i),29999])
  expect(sparseIndices(-5,4,30000)).toEqual([0,1,2,3])
})
