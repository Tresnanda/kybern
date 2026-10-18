import {test,expect} from 'bun:test'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import path from 'node:path'
import {useEffect,useRef,useState} from 'react'
import type {PublicInstance} from '@gpuix/react'
import {SparseRetention,sparseIndices,useSparseList} from '../kit/sparseList.tsx'
import {TranscriptSlot,useTranscriptRowLease,useTranscriptWindow} from './Window.tsx'
const entry=createRequire(import.meta.url).resolve('@gpuix/react')
const {createRoot,flushSync}=await import(pathToFileURL(path.join(path.dirname(entry),'reconciler/reconciler.js')).href)

test('native anchor changes dispose rich bodies, preserve selected/overlay owners with sparse slots',async()=>{
 let anchor=[1,0],selection:string|null=null,token=0,position=0,listId=0
 const targets=new Map<number,unknown>(),observers=new Map<number,(error:null,event:unknown)=>void>(),hosts=new Set<number>(),mounted=new Set<number>()
 const children=new Map<number,Set<number>>(),parents=new Map<number,number>()
 const overlays=new Map<number,(open:boolean)=>void>()
 const renderer={applyBatch(json:string){const destroyed:number[]=[];const drop=(id:number)=>{for(const child of children.get(id)??[])drop(child);children.delete(id);hosts.delete(id);destroyed.push(id)};for(const [op,id,value] of JSON.parse(json)){if(op==='createElement'){hosts.add(id);if(value==='virtual-list')listId=id};if(op==='destroyElement')drop(id);if(op==='appendChild'||op==='insertBefore'){children.get(parents.get(value)!)?.delete(value);parents.set(value,id);if(!children.has(id))children.set(id,new Set());children.get(id)!.add(value)}}return destroyed},setWindowKeyEvents(){},setWindowSelectionChange(){},getSelectedText(){return selection},getListScrollTop(){return anchor},addLayoutObserver(target:unknown,callback:(error:null,event:unknown)=>void){observers.set(++token,callback);targets.set(token,target);return token},removeLayoutObserver(id:number){observers.delete(id);targets.delete(id)},isLayoutObserverActive(id:number){return observers.has(id)}}
 const keys=Array.from({length:3000},(_,i)=>String(i))
 function Body({index}:{index:number}){const[open,setOpen]=useState(false);useTranscriptRowLease(open);useEffect(()=>{mounted.add(index);overlays.set(index,setOpen);return()=>{mounted.delete(index);overlays.delete(index)}},[index]);return <text>{`Body ${index}`}</text>}
 function List(){const list=useRef<PublicInstance|null>(null),window=useTranscriptWindow(keys,list,800,'test',0,[],index=>{position=index}),native=useSparseList(keys,[],0),indices=sparseIndices(window.range.start,window.range.end,keys.length,[...native.retained,...window.selected].map(key=>native.indices.get(key)!));return <SparseRetention.Provider value={native.context}><virtual-list ref={list}>{indices.map(index=>{const key=keys[index]!;return <TranscriptSlot key={key} rowKey={key} height={window.height(key)} mounted={true} measure={window.measure} sync={window.sync}><Body index={index}/></TranscriptSlot>})}</virtual-list></SparseRetention.Provider>}
 const root=createRoot(renderer)
 const settle=async()=>{await Bun.sleep(1);flushSync(()=>{});await Bun.sleep(1)}
 const move=async(index:number,frame:number)=>{anchor=[index+1,0];const entry=[...observers].find(([token])=>targets.get(token)===listId);const callback=entry?.[1];expect(callback).toBeDefined();flushSync(()=>callback!(null,{elementId:1,rect:null,scrollTop:anchor,frame}));await settle()}
 try{
  flushSync(()=>root.render(<List/>));await settle()
  expect(mounted.size).toBeLessThan(40);expect(observers.size).toBeLessThan(40)
  await move(500,1);expect(position).toBeGreaterThanOrEqual(500);expect(position).toBeLessThan(510);expect(mounted.has(500)).toBe(true);expect(mounted.has(0)).toBe(false)
  flushSync(()=>overlays.get(500)!(true));await settle()
  await move(700,2);expect(mounted.has(500)).toBe(true);expect(mounted.has(700)).toBe(true)
  flushSync(()=>overlays.get(500)!(false));await settle();expect(mounted.has(500)).toBe(false)
  selection='selected code';await move(900,3);expect(mounted.has(700)).toBe(true);expect(mounted.has(900)).toBe(true)
  selection=null;await move(1100,4);expect(mounted.has(700)).toBe(false);expect(mounted.has(900)).toBe(false);expect(mounted.has(1100)).toBe(true)
  expect(mounted.size).toBeLessThan(40);expect(observers.size).toBeLessThan(40)
  expect(hosts.size).toBeLessThan(100)
 }finally{root.unmount()}
 expect(observers.size).toBe(0);expect(mounted.size).toBe(0);expect(hosts.size).toBe(0)
})
