import '../native/local-build.ts'
import {strict as assert} from 'node:assert'
import type {NativeRenderer, PublicInstance, EventPayload} from '@gpuix/react'
import type {TaskItem, TaskStatus} from '../../../../packages/kybern-client/src/types.ts'
const {setTasks, taskState} = await import('./store.ts')
const {beginTaskDrag,trackTaskDrag,cancelTaskDrag,slotRef,regionRef,viewportRef,taskShift,taskPlaceholder} = await import('./drag.tsx')
const item=(id:string,status:TaskStatus,rank:number)=>({id,key:id,scope:'global',title:id,body:'',status,priority:0,rank,note_ids:[],runs:[],revision:1,created_at:'2026-10-18T00:00:00Z',updated_at:'2026-10-18T00:00:00Z',status_changed_at:'2026-10-18T00:00:00Z'} satisfies TaskItem)
const node=(id:number)=>({id} as PublicInstance)
const move=(x:number,y:number):EventPayload=>({elementId:9,eventType:'mouseMove',x,y,pressedButton:0})
function setup(view:'list'|'board',tasks:TaskItem[],boxes:[number,{x:number;y:number;width:number;height:number}][]) {
  setTasks({tasks:Object.fromEntries(tasks.map(t=>[t.id,t])),prefs:{...taskState().prefs,view,grouping:'status',ordering:'manual'}})
  const map=new Map(boxes)
  viewportRef(node(1))
  return {getElementBounds:(id:number)=>map.get(id)??null} as NativeRenderer
}

// List: the last Inbox row dragged up into To do, the group above. Everything between its slot and its
// home moves down one row, the Inbox header included; the held row's own translation puts it in the slot.
{
  const tasks=[item('t1','todo',0),item('i1','inbox',0),item('i2','inbox',1)]
  const renderer=setup('list',tasks,[[1,{x:0,y:0,width:800,height:600}],[2,{x:0,y:0,width:800,height:40}],[3,{x:0,y:40,width:800,height:40}],[4,{x:0,y:80,width:800,height:50}],[5,{x:0,y:130,width:800,height:40}],[6,{x:0,y:170,width:800,height:40}]])
  regionRef('status:todo',node(2),'todo',['t1'],false);regionRef('status:inbox',node(4),'inbox',['i1','i2'],false)
  slotRef('t1',node(3));slotRef('i1',node(5));slotRef('i2',node(6))
  beginTaskDrag('i2',{elementId:6,eventType:'mouseDown',button:0,x:200,y:190},renderer,['t1','i1','i2'])
  trackTaskDrag(move(200,120));trackTaskDrag(move(200,45))
  assert.equal(taskShift.get('t1'),40)
  assert.equal(taskShift.get('header:status:inbox'),40)
  assert.equal(taskShift.get('i1'),40)
  assert.equal(taskShift.get('i2'),40-170)
  assert.equal(taskShift.get('header:status:todo'),0)
  cancelTaskDrag();regionRef('status:todo',null,'todo',[],false);regionRef('status:inbox',null,'inbox',[],false);for(const id of ['t1','i1','i2'])slotRef(id,null)
}

// Board: a tall card dragged past a short one. The short card moves up by the tall card's pitch; the dimmed
// source moves down by the short card's, so it fills exactly the room that opens. In the next column the source
// cannot be translated: a placeholder takes the slot there and the source keeps no offset.
{
  const tasks=[item('tall','inbox',0),item('short','inbox',1),item('other','todo',0)]
  const renderer=setup('board',tasks,[[1,{x:0,y:0,width:800,height:600}],[2,{x:0,y:0,width:200,height:600}],[3,{x:212,y:0,width:200,height:600}],[4,{x:0,y:46,width:200,height:108}],[5,{x:0,y:154,width:200,height:48}],[6,{x:212,y:46,width:200,height:48}]])
  regionRef('board:inbox',node(2),'inbox',['tall','short'],true);regionRef('board:todo',node(3),'todo',['other'],true)
  slotRef('tall',node(4));slotRef('short',node(5));slotRef('other',node(6))
  beginTaskDrag('tall',{elementId:4,eventType:'mouseDown',button:0,x:100,y:60},renderer,['tall','short','other'])
  trackTaskDrag(move(100,120));trackTaskDrag(move(100,190))
  assert.equal(taskShift.get('short'),-108)
  assert.equal(taskShift.get('tall'),48)
  assert.equal(taskPlaceholder.get(),null)
  trackTaskDrag(move(300,50))
  assert.equal(taskShift.get('short'),-108)
  assert.equal(taskShift.get('other'),108)
  assert.equal(taskShift.get('tall'),0)
  assert.deepEqual(taskPlaceholder.get()&&{status:taskPlaceholder.get()!.status,y:taskPlaceholder.get()!.slot.y},{status:'todo',y:46})
  cancelTaskDrag()
  assert.equal(taskPlaceholder.get(),null)
}
console.log('PASS held source fills its slot: list reflow with headers, board shift by passed cards, cross-column placeholder')
