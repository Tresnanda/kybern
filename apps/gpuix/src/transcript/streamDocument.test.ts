import {expect, test} from 'bun:test'
import {streamDocumentOwner, type StreamDocumentRevision} from './streamDocument.ts'
const revision=(n:number):StreamDocumentRevision=>({id:'document',revision:n,stablePrefixBlocks:Math.max(0,n-2),parsedBytes:4})
function deferred() { let resolve!:(value:StreamDocumentRevision)=>void;return {promise:new Promise<StreamDocumentRevision>(done=>resolve=done),resolve} }

test('coalesces to the newest pending source with one request in flight',async()=>{
  const first=deferred(),second=deferred(),requests:unknown[]=[],painted:number[]=[],released:string[]=[]
  const owner=streamDocumentOwner({createMarkdownDocument(options){requests.push(options);return first.promise},updateMarkdownDocument(id,options){requests.push({id,...options});return second.promise},releaseMarkdownDocument(id){released.push(id)}},d=>painted.push(d.revision),()=>{throw Error('unexpected')})
  owner.enqueue('one');owner.enqueue('two');owner.enqueue('exact final 漢字 🌿')
  expect(requests).toEqual([{text:'one'}]);first.resolve(revision(1));await Bun.sleep(0)
  expect(painted).toEqual([]);expect(requests).toEqual([{text:'one'},{id:'document',text:'exact final 漢字 🌿',expectedRevision:1}])
  second.resolve(revision(2));await Bun.sleep(0);expect(painted).toEqual([2])
  owner.enqueue('exact final 漢字 🌿');expect(requests.length).toBe(2)
  owner.dispose();expect(released).toEqual(['document'])
})

test('releases creation that finishes after unmount without publishing',async()=>{
  const task=deferred(),released:string[]=[],painted:unknown[]=[]
  const owner=streamDocumentOwner({createMarkdownDocument:()=>task.promise,updateMarkdownDocument:()=>{throw Error('unexpected')},releaseMarkdownDocument:id=>released.push(id)},d=>painted.push(d),()=>{throw Error('unexpected')})
  owner.enqueue('🌿');owner.dispose();task.resolve(revision(1));await Bun.sleep(0)
  expect(released).toEqual(['document']);expect(painted).toEqual([])
})

test('failed update releases its lease and preserves the readable fallback',async()=>{
  const released:string[]=[],errors:unknown[]=[]
  const owner=streamDocumentOwner({createMarkdownDocument:async()=>revision(1),updateMarkdownDocument:async()=>{throw Error('worker rejected')},releaseMarkdownDocument:id=>released.push(id)},()=>{},e=>errors.push(e))
  owner.enqueue('first');await Bun.sleep(0);owner.enqueue('replacement');await Bun.sleep(0)
  expect(errors.length).toBe(1);expect(released).toEqual(['document']);owner.dispose();expect(released.length).toBe(1)
})
