export interface VirtualTopology {
  readonly keys: readonly string[]
  readonly estimates: readonly number[]
}

/**
 * Keep the virtualizer's index callbacks stable while an immutable item array
 * replaces content without changing row identity or estimated geometry.
 *
 * The comparison allocates nothing on that common path. A topology change
 * copies the exact keys and estimates so callbacks never read mutable render
 * state or an older item array.
 */
export function reconcileVirtualTopology<T>(
  previous: VirtualTopology | null,
  items: readonly T[],
  getKey: (item: T, index: number) => string,
  estimateSize: (item: T, index: number) => number
): VirtualTopology {
  if (previous?.keys.length === items.length) {
    for (let index = 0; index < items.length; index++) {
      const item = items[index]!
      const key = getKey(item, index)
      const estimate = estimateSize(item, index)
      if (
        previous.keys[index] !== key ||
        !Object.is(previous.estimates[index], estimate)
      ) {
        const keys = previous.keys.slice(0, index)
        const estimates = previous.estimates.slice(0, index)
        keys.push(key)
        estimates.push(estimate)
        for (let tail = index + 1; tail < items.length; tail++) {
          keys.push(getKey(items[tail]!, tail))
          estimates.push(estimateSize(items[tail]!, tail))
        }
        return { keys, estimates }
      }
    }
    return previous
  }

  return {
    keys: items.map(getKey),
    estimates: items.map(estimateSize),
  }
}
