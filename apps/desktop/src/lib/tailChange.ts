// Streaming updates replace one block reference at the end of a work list
// (or append one). Derived structures that would otherwise be rebuilt for all
// 1,000+ blocks on every token can patch their previous result instead.

export type TailChange<T> =
  | { kind: "same" }
  | { kind: "tail"; index: number; before: T; after: T }
  | { kind: "append"; after: T }
  | { kind: "rebuild" }

/** Classify how `next` differs from `prev` by reference, without allocating. */
export function diffTail<T>(prev: readonly T[] | null, next: readonly T[]): TailChange<T> {
  if (!prev) return { kind: "rebuild" }
  if (prev === next) return { kind: "same" }
  const appended = next.length === prev.length + 1
  if (!appended && next.length !== prev.length) return { kind: "rebuild" }
  const shared = prev.length
  let changed = -1
  for (let index = 0; index < shared; index++) {
    if (prev[index] !== next[index]) {
      if (changed !== -1) return { kind: "rebuild" }
      changed = index
    }
  }
  if (appended) return changed === -1 ? { kind: "append", after: next[shared]! } : { kind: "rebuild" }
  if (changed === -1) return { kind: "same" }
  return { kind: "tail", index: changed, before: prev[changed]!, after: next[changed]! }
}
