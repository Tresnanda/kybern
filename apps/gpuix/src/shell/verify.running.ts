// Deterministic visual state only; no real provider turn is started.
import '../main.tsx'
import { getState, set, subscribe } from '../state.ts'
subscribe(() => {
  const state = getState()
  if (!state.open.loaded || !state.open.thread) return
  if (state.threads.find((item) => item.id === state.open.thread!.id)?.status === 'running') return
  const thread = { ...state.open.thread, status: 'running' as const }
  set({ threads: state.threads.map((item) => item.id === thread.id ? thread : item), open: { ...state.open, thread } })
})
