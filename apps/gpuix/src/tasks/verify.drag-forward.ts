import '../native/local-build.ts'
import {strict as assert} from 'node:assert'
import type {NativeRenderer, PublicInstance, EventPayload} from '@gpuix/react'
import type {TaskItem} from '../../../../packages/kybern-client/src/types.ts'
const {setTasks, taskState} = await import('./store.ts')
const {beginTaskDrag,trackTaskDrag,escapeTaskDrag,cancelTaskDrag,slotRef,regionRef,viewportRef,taskShift} = await import('./drag.tsx')
const ids=['first','second','third']
const tasks=Object.fromEntries(ids.map((id,rank)=>[id,{id,key:id,scope:'global',title:id,body:'',status:'inbox',priority:0,rank,note_ids:[],runs:[],revision:1,created_at:'2026-10-16T00:00:00Z',updated_at:'2026-10-16T00:00:00Z',status_changed_at:'2026-10-16T00:00:00Z'} satisfies TaskItem]))
setTasks({tasks,prefs:{...taskState().prefs,view:'list',grouping:'status',ordering:'manual'}})
const node=(id:number)=>({id} as PublicInstance)
const boxes=new Map([[1,{x:0,y:0,width:800,height:600}],[2,{x:0,y:0,width:800,height:600}],...ids.map((_,i)=>[i+3,{x:20,y:50+i*40,width:760,height:40}] as const)])
const renderer={getElementBounds:(id:number)=>boxes.get(id)??null} as NativeRenderer
viewportRef(node(1));regionRef('inbox',node(2),'inbox',ids,false)
ids.forEach((id,i)=>slotRef(id,node(i+3)))
beginTaskDrag('first',{elementId:3,eventType:'mouseDown',button:0,x:200,y:70},renderer,ids)
const event=(y:number,pressedButton?:number):EventPayload=>({elementId:3,eventType:'mouseMove',x:206,y,pressedButton})
trackTaskDrag(event(70,0))
assert.equal(taskShift.get('second'),0)
// A physical pressed stream may keep targeting the original host, even after
// the capture overlay has mounted. This second source event was discarded.
trackTaskDrag(event(140,0))
assert.equal(taskShift.get('second'),-40)
trackTaskDrag(event(180))
assert.equal(taskShift.get('third'),-40)
escapeTaskDrag();assert.equal(taskShift.get('second'),0)
cancelTaskDrag()
console.log('PASS sustained source-bound drag forwarding and missing-button notification')
