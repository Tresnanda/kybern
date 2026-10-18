import {expect,test} from 'bun:test'
import {eventFrame} from './eventFrame.ts'
test('one display subscription joins a burst and parks after delivery',()=>{
  let subscriptions=0,stops=0,notifies=0,frame:(()=>void)|undefined
  const queue=eventFrame(flush=>{subscriptions++;frame=flush;return()=>{stops++;frame=undefined}},()=>notifies++)
  for(let i=0;i<1000;i++)queue.next()
  expect(subscriptions).toBe(1);expect(notifies).toBe(0)
  frame!();expect(stops).toBe(1);expect(notifies).toBe(1);expect(frame).toBeUndefined()
  queue.next();expect(subscriptions).toBe(2)
  queue.now();expect(stops).toBe(2);expect(notifies).toBe(2);expect(frame).toBeUndefined()
})
