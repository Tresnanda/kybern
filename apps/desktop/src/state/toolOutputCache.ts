/** Lifecycle of saved tool results. Payloads live only in the transcript store;
 * this cache retains identities, in-flight requests, and mounted-view leases. */
export interface ToolOutputIdentity {
  threadId: string
  toolCallId: string
  seq: number
  turnId: string
  throughSeq?: number
  revision?: number
}

export interface ToolOutputLocation {
  seq: number
  turnId: string
  throughSeq?: number
  revision?: number
  omitted: boolean
}

export interface ToolOutputResponse<Output> {
  output: Output
  is_error: boolean
}

interface ToolOutputCacheOptions<Output> {
  read(threadId: string, toolCallId: string, seq?: number): ToolOutputLocation | undefined
  load(threadId: string, toolCallId: string, identity: ToolOutputIdentity): Promise<ToolOutputResponse<Output>>
  /** Apply only if this exact tool still exists and its output is omitted. */
  apply(identity: ToolOutputIdentity, result: ToolOutputResponse<Output>): boolean
  /** Omit only the matching hydrated tool; never create a missing transcript. */
  omit(identity: ToolOutputIdentity): void
  onError(error: unknown): void
}

// Preserve the previous warm-cache allowance for results not currently in use.
// Mounted content is not an eviction candidate: evicting it causes a refetch loop.
const MAX_INACTIVE_OUTPUTS = 12
// Leave room in the daemon's 16-request lane for subscriptions and interaction.
const MAX_CONCURRENT_LOADS = 4

export function createToolOutputCache<Output>(options: ToolOutputCacheOptions<Output>) {
  const hydrated = new Map<string, ToolOutputIdentity>()
  const consumers = new Map<string, number>()
  const loads = new Map<string, { identity: ToolOutputIdentity; request: Promise<void> }>()
  let generation = 0
  let disposed = false
  let activeLoads = 0
  let queuedLoads: { start(): void; cancel(): void }[] = []

  function stillOmitted(identity: ToolOutputIdentity): boolean {
    const current = options.read(identity.threadId, identity.toolCallId, identity.seq)
    return !!current?.omitted && current.seq === identity.seq && current.turnId === identity.turnId && current.revision === identity.revision
  }

  function drainLoads(): void {
    while (activeLoads < MAX_CONCURRENT_LOADS && queuedLoads.length) queuedLoads.shift()!.start()
  }

  function loadQueued(identity: ToolOutputIdentity, isCurrent: () => boolean): Promise<ToolOutputResponse<Output> | undefined> {
    const queuedGeneration = generation
    return new Promise((resolve, reject) => {
      queuedLoads.push({
        cancel: () => resolve(undefined),
        start() {
          if (!isCurrent() || !stillOmitted(identity)) { resolve(undefined); return }
          activeLoads++
          const finish = () => {
            if (queuedGeneration !== generation) return
            activeLoads--
            drainLoads()
          }
          try {
            void options.load(identity.threadId, identity.toolCallId, identity).then(resolve, reject).finally(finish)
          } catch (error) {
            reject(error)
            finish()
          }
        },
      })
      drainLoads()
    })
  }

  // Thread IDs are UUIDs; tool-call IDs may themselves contain colons.
  const keyFor = (threadId: string, toolCallId: string, seq?: number) => JSON.stringify([threadId, toolCallId, seq])

  function touch(key: string): void {
    const identity = hydrated.get(key)
    if (!identity) return
    hydrated.delete(key)
    hydrated.set(key, identity)
  }

  function evict(): void {
    let inactive = 0
    for (const key of hydrated.keys()) if (!consumers.has(key)) inactive++
    for (const [key, identity] of hydrated) {
      if (inactive <= MAX_INACTIVE_OUTPUTS) break
      if (consumers.has(key)) continue
      hydrated.delete(key)
      inactive--
      options.omit(identity)
    }
  }

  /** Each mounted consumer owns its own idempotent release function. */
  function retain(threadId: string, toolCallId: string, seq?: number): () => void {
    if (disposed) return () => {}
    const key = keyFor(threadId, toolCallId, seq ?? options.read(threadId, toolCallId)?.seq)
    consumers.set(key, (consumers.get(key) ?? 0) + 1)
    touch(key)
    let released = false
    return () => {
      if (released || disposed) return
      released = true
      const remaining = (consumers.get(key) ?? 1) - 1
      if (remaining > 0) {
        consumers.set(key, remaining)
      } else {
        consumers.delete(key)
        touch(key)
        evict()
      }
    }
  }

  function hydrate(threadId: string, toolCallId: string, seq?: number): Promise<void> {
    if (disposed) return Promise.resolve()
    const current = options.read(threadId, toolCallId, seq)
    const key = keyFor(threadId, toolCallId, seq ?? current?.seq)
    if (!current?.omitted) {
      if (current) touch(key)
      else hydrated.delete(key)
      return Promise.resolve()
    }
    const pending = loads.get(key)
    if (pending && pending.identity.seq === current.seq && pending.identity.turnId === current.turnId && pending.identity.revision === current.revision) return pending.request
    // Capture scalar identity, not the old block or transcript (which may be large).
    const identity = { threadId, toolCallId, seq: current.seq, turnId: current.turnId, throughSeq: current.throughSeq, revision: current.revision }
    const requestGeneration = generation
    const isCurrent = () => !disposed && requestGeneration === generation && loads.get(key)?.identity === identity
    const request = Promise.resolve()
      .then(() => {
        if (!isCurrent()) return
        return loadQueued(identity, isCurrent)
      })
      .then((result) => {
        if (!result || !isCurrent()) return
        // The store callback checks identity and omission in the same update,
        // avoiding a redundant transcript scan and a stale read/write split.
        if (!options.apply(identity, result)) return
        hydrated.delete(key)
        hydrated.set(key, identity)
        evict()
      })
      .catch((error: unknown) => {
        if (isCurrent() && stillOmitted(identity)) options.onError(error)
      })
      .finally(() => {
        // A stale completion must not remove a newer request for the same key.
        if (loads.get(key)?.request === request) loads.delete(key)
      })
    loads.set(key, { identity, request })
    return request
  }

  /** Invalidate old requests on a connection change without discarding visible
   * results or their leases. The view retries omitted results on reconnect. */
  function invalidatePending(): void {
    generation++
    loads.clear()
    for (const load of queuedLoads) load.cancel()
    queuedLoads = []
    activeLoads = 0
  }

  function dispose(): void {
    disposed = true
    invalidatePending()
    hydrated.clear()
    consumers.clear()
  }

  return { hydrate, retain, invalidatePending, dispose }
}
