/**
 * Merge a daemon snapshot without letting it roll back records that advanced
 * through the live event stream while the request was in flight.
 *
 * Records missing from the snapshot are retained. The event subscription is
 * authoritative for removals/archives and may already have introduced a new
 * record after the daemon began building the snapshot.
 */
export function mergeSequencedSnapshot<K extends string, T extends { id: K; last_seq: number }>(
  current: Readonly<Record<K, T>>,
  snapshot: readonly T[],
): Record<K, T> {
  const merged: Record<K, T> = { ...current }
  for (const incoming of snapshot) {
    const existing = current[incoming.id]
    merged[incoming.id] = existing && existing.last_seq > incoming.last_seq ? existing : incoming
  }
  return merged
}

/** Advance an event-backed projection to the fold's actual high-water mark. */
export function advanceSequence<T extends { last_seq: number }>(record: T, sequence: number): T {
  return record.last_seq < sequence ? { ...record, last_seq: sequence } : record
}
