import { createContext, useCallback, useEffect, useMemo, useRef, useState } from 'react'

/** Semantic IDs/heights travel only on data changes. Native retains measurements
 * after hosts leave the window; offscreen owners are explicit sparse exceptions. */
export const SparseRetention = createContext<null | { retain: (key: string, active: boolean) => void; visited: Set<string> }>(null)
let generation = 0
export function useSparseList(keys: readonly string[], estimates: readonly number[], layout: string | number) {
  const owners = useRef<ReadonlySet<string>>(new Set())
  const [retained, setRetained] = useState(owners.current)
  const retain = useCallback((key: string, active: boolean) => {
    // Disposal runs during commit. Calling even a same-value updater there can
    // queue another root commit; most disposed slots never owned a lease.
    const previous = owners.current
    if (previous.has(key) === active) return
    const next = new Set(previous)
    if (active) next.add(key); else next.delete(key)
    owners.current = next
    setRetained(next)
  }, [])
  const visited = useRef(new Set<string>())
  const metadata = useRef({ keys, estimates, version: ++generation })
  if (metadata.current.keys !== keys || metadata.current.estimates !== estimates) {
    const previous = metadata.current
    if (keys.length !== previous.keys.length || estimates.length !== previous.estimates.length || keys.some((key,i) => key !== previous.keys[i]) || estimates.some((height,i) => height !== previous.estimates[i])) metadata.current = { keys, estimates, version: ++generation }
  }
  const stable = metadata.current
  const indices = useMemo(() => new Map(stable.keys.map((key, index) => [key, index])), [stable.keys])
  useEffect(() => {
    const valid = new Set(stable.keys)
    for (const key of visited.current) if (!valid.has(key)) visited.current.delete(key)
    const previous = owners.current
    const next = new Set([...previous].filter(key => valid.has(key)))
    if (next.size !== previous.size) { owners.current = next; setRetained(next) }
  }, [stable.keys])
  const sparseVersion = stable.version
  const sparseLayout = useMemo(() => ++generation, [layout])
  const context = useMemo(() => ({ retain, visited: visited.current }), [retain])
  const props = { sparseKeys: stable.keys, sparseEstimates: stable.estimates, sparseVersion, sparseLayout }
  return { retained, indices, context, props }
}

/** Range + owners stays O(window + owners), even for a distant leased row. */
export function sparseIndices(start: number, end: number, size: number, pinned: Iterable<number> = []) {
  const result = new Set<number>()
  for (let i = Math.max(0, start); i < Math.min(end, size); i++) result.add(i)
  for (const i of pinned) if (i >= 0 && i < size) result.add(i)
  return [...result].sort((a, b) => a - b)
}
