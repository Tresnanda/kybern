import { expect, test } from 'bun:test'
import { createStreamTopology } from './streamBlocks.ts'
import { applyEvent, emptyThreadState, type Block } from '../../../../packages/kybern-client/src/transcript.ts'

const assistant = (text: string): Extract<Block, {kind: 'assistant'}> => ({kind:'assistant', id:'a#0', messageId:'a', segment:0, turnId:'turn', at:'now', seq:1, origin:{kind:'root'}, text, thinking:'', complete:false})

test('text deltas keep transcript topology stable; row state stays canonical', () => {
  const select = createStreamTopology(), first = assistant('A whole word ')
  const history = Array.from({length:3000}, (_,i):Block => ({kind:'notice',id:String(i),turnId:String(i),seq:i,at:'now',level:'info',text:'settled'}))
  const start = [...history, first], shape = select(start)
  for (let i=0; i<1000; i++) expect(select([...history, {...first,text:first.text+'🌿 '.repeat(i)}])).toBe(shape)
  expect(shape.at(-1)).toBe(first)
  const final = {...first, text:'Exact final 漢字 🌿', complete:true}
  const completed = select([...history,final])
  expect(completed).not.toBe(shape)
  expect(completed.at(-1)).toBe(final)
  expect(completed[0]).toBe(history[0])
})

test('publish reveal, reasoning, tool, completion and replacement transitions', () => {
  const select = createStreamTopology(), first = assistant('A')
  let previous = select([first])
  for (const block of [{...first,text:'A readable fragment'}, {...first,thinking:'reasoning'}, {...first,thinkingComplete:true}, {...first,complete:true}, {...first,id:'another'}]) {
    const next = select([block]); expect(next).not.toBe(previous); expect(next[0]).toBe(block); previous=next
  }
  expect(select([])).toEqual([])
})

test('production segmented deltas preserve topology until the terminal event', () => {
  let state=emptyThreadState(), seq=0
  const select=createStreamTopology()
  const push=(payload:object) => { state=applyEvent(state,{thread_id:'thread',turn_id:'turn',seq:++seq,at:'now',...payload} as never); return select(state.blocks) }
  push({kind:'turn_started',message_id:'user',message:{parts:[{type:'text',text:'hello'}]}})
  const shape=push({kind:'assistant_text_delta',message_id:'a',origin:{kind:'root'},delta:'Hello world '})
  expect(push({kind:'assistant_text_delta',message_id:'a',origin:{kind:'root'},delta:'🌿'})).toBe(shape)
  expect(push({kind:'assistant_message_completed',message_id:'a',origin:{kind:'root'},text:'Hello world 🌿',thinking:null})).not.toBe(shape)
})
