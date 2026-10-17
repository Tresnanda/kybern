// Full-app deterministic running scene. Reads scratch data; changes only this process's state.
import '../src/main.tsx'
import { getState, set, subscribe } from '../src/state.ts'
const stop = subscribe(() => {
  const state = getState()
  if (!state.open.loaded || !state.open.thread) return
  const user = state.open.blocks.find(block => block.kind === 'user')
  const tool = state.open.blocks.find(block => block.kind === 'tool')
  if (!user || !tool) return
  stop()
  const thread = { ...state.open.thread, title: 'Native performance fixture', status: 'running' as const }
  set({
    threads: state.threads.map(item => item.id === thread.id ? thread : item),
    open: { ...state.open, thread, blocks: [user, { ...tool, turnId: user.turnId, complete: false }], nextBeforeSeq: null },
  })
})
