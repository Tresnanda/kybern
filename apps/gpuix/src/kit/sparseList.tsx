import { createContext, useCallback, useEffect, useMemo, useRef, useState } from 'react'

/** Semantic IDs/heights travel only on data changes. Native retains measurements
 * after hosts leave the window; offscreen owners are explicit sparse exceptions. */
export const SparseRetention = createContext<null | { retain: (key: string, active: boolean) => void; visited: Set<string> }>(null)
let generation = 0
export function useSparseList(keys: readonly string[], estimates: readonly number[], layout: string | number) {
  const [retained, setRetained] = useState<ReadonlySet<string>>(() => new Set())
  const retain = useCallback((key: string, active: boolean) => setRetained(previous => {
    if (previous.has(key) === active) return previous
    const next = new Set(previous)
    if (active) next.add(key); else next.delete(key)
    return next
  }), [])
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
    setRetained(previous => {
      const next = new Set([...previous].filter(key => valid.has(key)))
      return next.size === previous.size ? previous : next
    })
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
