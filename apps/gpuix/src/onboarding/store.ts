// A tiny external store: module state plus `useSyncExternalStore`, the pattern every store in this app uses.
import { useSyncExternalStore } from 'react'

export interface Store<T> {
  get: () => T
  set: (patch: Partial<T> | ((state: T) => Partial<T>)) => void
  /** Replace the whole state (a reset). */
  reset: (state: T) => void
  subscribe: (listener: () => void) => () => void
  use: <S>(select: (state: T) => S) => S
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial
  const listeners = new Set<() => void>()
  const emit = () => { for (const listener of [...listeners]) listener() }
  const store: Store<T> = {
    get: () => state,
    set: (patch) => {
      const next = typeof patch === 'function' ? patch(state) : patch
      if (Object.keys(next).every((key) => Object.is((state as Record<string, unknown>)[key], (next as Record<string, unknown>)[key]))) return
      state = { ...state, ...next }
      emit()
    },
    reset: (next) => { state = next; emit() },
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    use: (select) => useSyncExternalStore(store.subscribe, () => select(state)),
  }
  return store
}
