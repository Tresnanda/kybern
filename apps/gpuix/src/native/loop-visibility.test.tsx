import {expect, test} from 'bun:test'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import path from 'node:path'
import {useEffect} from 'react'
import {hasVisiblePaint, useLoopVisibility} from './loop-visibility.ts'
const entry=createRequire(import.meta.url).resolve('@gpuix/react')
const {createRoot,flushSync}=await import(pathToFileURL(path.join(path.dirname(entry),'reconciler/reconciler.js')).href)

test('paint visibility respects clipping, absence, zero area and partial intersection',()=>{
 const rect={x:20,y:20,width:14,height:14}
 expect(hasVisiblePaint({rect,clippedRect:{x:0,y:0,width:100,height:100}})).toBe(true)
 expect(hasVisiblePaint({rect,clippedRect:{x:30,y:30,width:100,height:100}})).toBe(true)
 for(const clippedRect of [null,{x:34,y:0,width:100,height:100},{x:0,y:34,width:100,height:100},{x:20,y:20,width:0,height:100}])expect(hasVisiblePaint({rect,clippedRect})).toBe(false)
 expect(hasVisiblePaint({rect:null,clippedRect:rect})).toBe(false)
})
test('a retained loop subscribes only while painted and removes its observer on teardown',async()=>{
 let token=0,active=false,subscriptions=0,starts=0,renders=0
 const observers=new Map<number,(error:null,event:unknown)=>void>()
 const renderer={applyBatch(){return []},setWindowKeyEvents(){},setWindowSelectionChange(){},
  addLayoutObserver(_target:unknown,callback:(error:null,event:unknown)=>void){observers.set(++token,callback);return token},
  removeLayoutObserver(id:number){observers.delete(id)},isLayoutObserverActive(id:number){return observers.has(id)}}
 function Loop(){const loop=useLoopVisibility(active);renders++;useEffect(()=>{if(loop.visible){subscriptions++;starts++;return()=>{subscriptions--}}},[loop.visible]);return <div ref={loop.ref} />}
 const root=createRoot(renderer)
 const settle=async()=>{await Bun.sleep(1);flushSync(()=>{});await Bun.sleep(1)}
 const paint=async(rect:{x:number;y:number;width:number;height:number}|null)=>{const callback=[...observers.values()][0]!;expect(callback).toBeDefined();flushSync(()=>callback(null,{elementId:1,rect,clippedRect:{x:0,y:0,width:100,height:100},frame:1}));await settle()}
 try{
  flushSync(()=>root.render(<Loop/>));await settle();expect(observers.size).toBe(0);expect(subscriptions).toBe(0)
  active=true;flushSync(()=>root.render(<Loop/>));await settle();expect(observers.size).toBe(1);expect(subscriptions).toBe(0)
  await paint({x:0,y:200,width:14,height:14});expect(subscriptions).toBe(0)
  await paint({x:0,y:10,width:14,height:14});expect(subscriptions).toBe(1);expect(starts).toBe(1)
  await paint({x:0,y:11,width:14,height:14});await paint({x:0,y:12,width:14,height:14});expect(starts).toBe(1)
  await paint(null);expect(subscriptions).toBe(0)
  await paint({x:0,y:10,width:14,height:14});expect(subscriptions).toBe(1);expect(starts).toBe(2)
  active=false;flushSync(()=>root.render(<Loop/>));await settle();expect(subscriptions).toBe(0);expect(observers.size).toBe(0)
 }finally{root.unmount();await settle()}
 expect(subscriptions).toBe(0);expect(observers.size).toBe(0)
})
