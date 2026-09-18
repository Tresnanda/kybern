import assert from "node:assert/strict"
import test from "node:test"
import { createToolOutputCache, MAX_INACTIVE_OUTPUT_BYTES, OVERSIZED_OUTPUT_BYTES, toolOutputIsOversized } from "./src/state/toolOutputCache.ts"

const response = (output) => ({ output, is_error: false })
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture(reply) {
  const blocks = new Map()
  const errors = [], omitted = []
  let calls = 0, writes = 0
  const key = (t, c) => `${t}:${c}`
  const cache = createToolOutputCache({
    read(t, c) {
      const block = blocks.get(key(t, c))
      return block && { seq: block.seq, turnId: block.turnId, omitted: block.outputOmitted, bytes: typeof block.output === "string" ? block.output.length * 2 : 0 }
    },
    load(t, c) {
      calls++
      return reply ? reply(t, c) : Promise.resolve(response(`exact:${t}:${c}`))
    },
    apply(identity, result) {
      const block = blocks.get(key(identity.threadId, identity.toolCallId))
      if (!block?.outputOmitted || block.seq !== identity.seq || block.turnId !== identity.turnId) return false
      blocks.set(key(identity.threadId, identity.toolCallId), {
        ...block, output: result.output, isError: result.is_error, outputOmitted: false,
      })
      writes++
      return true
    },
    omit(identity) {
      const id = key(identity.threadId, identity.toolCallId)
      const block = blocks.get(id)
      if (!block || block.seq !== identity.seq || block.turnId !== identity.turnId) return
      blocks.set(id, { ...block, output: null, outputOmitted: true })
      omitted.push(id)
    },
    onError(error) { errors.push(error) },
  })
  function add(c, t = "t", extra = {}) {
    const block = { seq: blocks.size + 1, turnId: "turn", output: null, outputOmitted: true, ...extra }
    blocks.set(key(t, c), block)
    return block
  }
  const get = (c, t = "t") => blocks.get(key(t, c))
  return { cache, blocks, add, get, errors, omitted, get calls() { return calls }, get writes() { return writes } }
}

async function loadInactive(f, start, count) {
  for (let i = start; i < start + count; i++) {
    f.add(`c${i}`)
    await f.cache.hydrate("t", `c${i}`)
  }
}

test("opening many mounted results queues hydration below the RPC lane limit", async () => {
  let active = 0, peak = 0
  const f = fixture(async (_thread, id) => {
    active++
    peak = Math.max(peak, active)
    await new Promise(resolve => setImmediate(resolve))
    active--
    return response(`exact:${id}`)
  })
  const releases = [], requests = []
  for (let i = 0; i < 40; i++) {
    f.add(`c${i}`)
    releases.push(f.cache.retain("t", `c${i}`))
    requests.push(f.cache.hydrate("t", `c${i}`))
  }
  await Promise.all(requests)
  assert.equal(peak, 4)
  assert.equal(f.calls, 40)
  assert.equal(f.writes, 40)
  assert.equal(f.errors.length, 0)
  for (let i = 0; i < 40; i++) assert.equal(f.get(`c${i}`).output, `exact:c${i}`)
  for (const release of releases) release()
})

test("reconnect cancels queued loads and old completions cannot drain the new queue", async () => {
  const pending = []
  const f = fixture(() => { const value = deferred(); pending.push(value); return value.promise })
  for (let i = 0; i < 8; i++) f.add(`c${i}`)
  const old = Array.from({ length: 8 }, (_, i) => f.cache.hydrate("t", `c${i}`))
  await Promise.resolve()
  assert.equal(f.calls, 4)
  f.cache.invalidatePending()
  const fresh = Array.from({ length: 8 }, (_, i) => f.cache.hydrate("t", `c${i}`))
  await Promise.resolve()
  assert.equal(f.calls, 8)
  for (const item of pending.slice(0, 4)) item.resolve(response("obsolete"))
  await Promise.all(old)
  assert.equal(f.calls, 8)
  assert.equal(f.writes, 0)
  for (const item of pending.slice(4, 8)) item.resolve(response("fresh"))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.calls, 12)
  for (const item of pending.slice(8)) item.resolve(response("fresh"))
  await Promise.all(fresh)
  assert.equal(f.writes, 8)
  assert.ok([...f.blocks.values()].every(block => block.output === "fresh"))
})

test("a failed hydration releases its queue slot and disposal cancels queued work", async () => {
  const pending = []
  const f = fixture(() => { const value = deferred(); pending.push(value); return value.promise })
  for (let i = 0; i < 8; i++) f.add(`c${i}`)
  const requests = Array.from({ length: 8 }, (_, i) => f.cache.hydrate("t", `c${i}`))
  await Promise.resolve()
  pending[0].reject(new Error("current failure"))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.calls, 5)
  assert.equal(f.errors.length, 1)
  f.cache.dispose()
  for (const item of pending.slice(1)) item.resolve(response("late"))
  await Promise.all(requests)
  assert.equal(f.calls, 5)
  assert.equal(f.writes, 0)
})

test("queued deleted rows never issue an RPC and deleted in-flight rows suppress late errors", async () => {
  const pending = []
  const f = fixture(() => { const value = deferred(); pending.push(value); return value.promise })
  for (let i = 0; i < 8; i++) f.add(`c${i}`)
  const requests = Array.from({ length: 8 }, (_, i) => f.cache.hydrate("t", `c${i}`))
  await Promise.resolve()
  assert.equal(f.calls, 4)
  f.blocks.clear()
  for (const item of pending) item.reject(new Error("deleted"))
  await Promise.all(requests)
  assert.equal(f.calls, 4)
  assert.equal(f.writes, 0)
  assert.equal(f.errors.length, 0)
})

test("13 mounted results are all retained and fetched only once", async () => {
  const f = fixture()
  const releases = []
  for (let i = 0; i < 13; i++) {
    const id = `c${i}`
    f.add(id)
    releases.push(f.cache.retain("t", id))
    await f.cache.hydrate("t", id)
  }
  assert.equal(f.calls, 13)
  assert.equal(f.writes, 13)
  assert.equal(f.omitted.length, 0)
  for (let i = 0; i < 13; i++) {
    assert.equal(f.get(`c${i}`).outputOmitted, false)
    await f.cache.hydrate("t", `c${i}`)
  }
  assert.equal(f.calls, 13)
  for (const release of releases) release()
  assert.equal([...f.blocks.values()].filter(b => !b.outputOmitted).length, 12)
})

test("the existing 12-result inactive warm cache is preserved", async () => {
  const f = fixture()
  await loadInactive(f, 0, 14)
  assert.equal(f.calls, 14)
  assert.deepEqual(f.omitted, ["t:c0", "t:c1"])
  assert.equal([...f.blocks.values()].filter(b => !b.outputOmitted).length, 12)
})

test("mounted results do not consume the inactive warm-cache allowance", async () => {
  const f = fixture()
  for (let i = 0; i < 15; i++) {
    f.add(`p${i}`)
    f.cache.retain("t", `p${i}`)
    await f.cache.hydrate("t", `p${i}`)
  }
  await loadInactive(f, 0, 25)
  assert.equal([...f.blocks.values()].filter(b => !b.outputOmitted).length, 27)
  for (let i = 0; i < 15; i++) assert.equal(f.get(`p${i}`).outputOmitted, false)
})

test("two views of one result own independent idempotent leases", async () => {
  const f = fixture()
  f.add("shared")
  const first = f.cache.retain("t", "shared")
  const second = f.cache.retain("t", "shared")
  await f.cache.hydrate("t", "shared")
  await loadInactive(f, 0, 20)
  first(); first()
  await loadInactive(f, 20, 20)
  assert.equal(f.get("shared").outputOmitted, false)
  second(); second()
  // Recently closed content remains warm, then can be evicted normally.
  assert.equal(f.get("shared").outputOmitted, false)
  await loadInactive(f, 40, 12)
  assert.equal(f.get("shared").outputOmitted, true)
})

test("revisiting a warm result updates recency without loading it again", async () => {
  const f = fixture()
  await loadInactive(f, 0, 12)
  await f.cache.hydrate("t", "c0")
  await loadInactive(f, 12, 1)
  assert.equal(f.calls, 13)
  assert.equal(f.get("c0").outputOmitted, false)
  assert.deepEqual(f.omitted, ["t:c1"])
})

test("duplicate hydration shares the exact same promise and payload", async () => {
  const d = deferred(), output = { nested: ["exact", { value: 7 }] }
  const f = fixture(() => d.promise)
  f.add("c")
  const first = f.cache.hydrate("t", "c")
  const second = f.cache.hydrate("t", "c")
  assert.strictEqual(first, second)
  await Promise.resolve()
  assert.equal(f.calls, 1)
  d.resolve(response(output))
  await first
  assert.strictEqual(f.get("c").output, output, "no serialized or cloned second payload")
})

test("disposing before the queued microtask prevents the RPC", async () => {
  const f = fixture(); f.add("c")
  const request = f.cache.hydrate("t", "c")
  f.cache.dispose()
  await request
  assert.equal(f.calls, 0)
  assert.equal(f.writes, 0)
})

test("disconnect discards late successes and releases all lease bookkeeping", async () => {
  const d = deferred(), f = fixture(() => d.promise)
  f.add("c")
  const release = f.cache.retain("t", "c")
  const request = f.cache.hydrate("t", "c")
  await Promise.resolve()
  f.cache.dispose(); f.blocks.clear()
  d.resolve(response("late")); await request
  release(); release(); f.cache.dispose()
  await f.cache.hydrate("t", "c")
  assert.equal(f.calls, 1)
  assert.equal(f.writes, 0)
  assert.equal(f.blocks.size, 0)
  assert.equal(f.errors.length, 0)
})

test("a stale error after disconnect does not show a toast", async () => {
  const d = deferred(), f = fixture(() => d.promise)
  f.add("c")
  const request = f.cache.hydrate("t", "c")
  await Promise.resolve(); f.cache.dispose()
  d.reject(new Error("old connection")); await request
  assert.deepEqual(f.errors, [])
})

test("a connection generation change permits a fresh request for the same key", async () => {
  const old = deferred(), fresh = deferred()
  let attempt = 0
  const f = fixture(() => (++attempt === 1 ? old.promise : fresh.promise))
  f.add("c")
  const first = f.cache.hydrate("t", "c")
  await Promise.resolve(); f.cache.invalidatePending()
  const second = f.cache.hydrate("t", "c")
  await Promise.resolve()
  assert.notStrictEqual(first, second)
  old.resolve(response("stale")); await first
  assert.equal(f.get("c").outputOmitted, true)
  assert.strictEqual(f.cache.hydrate("t", "c"), second, "old finally must not delete the new request")
  fresh.resolve(response("fresh")); await second
  assert.equal(f.get("c").output, "fresh")
  assert.equal(f.calls, 2)
})

test("connection changes do not drop visible results or mounted leases", async () => {
  const f = fixture()
  f.add("visible")
  const release = f.cache.retain("t", "visible")
  await f.cache.hydrate("t", "visible")
  f.cache.invalidatePending()
  await loadInactive(f, 0, 30)
  assert.equal(f.get("visible").outputOmitted, false)
  release()
})

test("late results cannot recreate a removed thread or tool", async () => {
  const d = deferred(), f = fixture(() => d.promise)
  f.add("c")
  const request = f.cache.hydrate("t", "c")
  await Promise.resolve(); f.blocks.delete("t:c")
  d.resolve(response("removed")); await request
  assert.equal(f.blocks.has("t:c"), false)
  assert.equal(f.writes, 0)
})

test("reusing a tool-call ID at another sequence cannot accept an old result", async () => {
  const d = deferred(), f = fixture(() => d.promise)
  f.add("c", "t", { seq: 1 })
  const request = f.cache.hydrate("t", "c")
  await Promise.resolve(); f.add("c", "t", { seq: 2 })
  d.resolve(response("old tool")); await request
  assert.equal(f.get("c").outputOmitted, true)
  assert.equal(f.writes, 0)
})

test("a changed turn identity cannot accept an old result", async () => {
  const d = deferred(), f = fixture(() => d.promise)
  f.add("c", "t", { seq: 1, turnId: "old" })
  const request = f.cache.hydrate("t", "c")
  await Promise.resolve(); f.add("c", "t", { seq: 1, turnId: "new" })
  d.resolve(response("old turn")); await request
  assert.equal(f.get("c").outputOmitted, true)
  assert.equal(f.writes, 0)
})

test("hydrated or inlined replacement data is not overwritten by an old request", async () => {
  const d = deferred(), f = fixture(() => d.promise)
  f.add("c", "t", { seq: 1 })
  const request = f.cache.hydrate("t", "c")
  await Promise.resolve()
  f.add("c", "t", { seq: 1, outputOmitted: false, output: "new snapshot" })
  d.resolve(response("old payload")); await request
  assert.equal(f.get("c").output, "new snapshot")
  assert.equal(f.writes, 0)
})

test("inlined and missing tool results are no-ops", async () => {
  const f = fixture()
  f.add("inline", "t", { outputOmitted: false, output: "existing" })
  await f.cache.hydrate("t", "inline")
  await f.cache.hydrate("t", "absent")
  assert.equal(f.calls, 0)
  assert.equal(f.writes, 0)
})

test("current errors are surfaced once and the request can be retried", async () => {
  let attempt = 0
  const expected = new Error("unavailable")
  const f = fixture(() => ++attempt === 1 ? Promise.reject(expected) : Promise.resolve(response("recovered")))
  f.add("c")
  await f.cache.hydrate("t", "c")
  assert.deepEqual(f.errors, [expected])
  await f.cache.hydrate("t", "c")
  assert.equal(f.get("c").output, "recovered")
  assert.equal(f.calls, 2)
})

test("thread boundaries and colon-containing tool IDs do not share cache entries", async () => {
  const f = fixture()
  f.add("worker:call", "thread-one")
  f.add("worker:call", "thread-two")
  const release = f.cache.retain("thread-one", "worker:call")
  await Promise.all([
    f.cache.hydrate("thread-one", "worker:call"),
    f.cache.hydrate("thread-two", "worker:call"),
  ])
  assert.equal(f.calls, 2)
  assert.equal(f.get("worker:call", "thread-one").output, "exact:thread-one:worker:call")
  assert.equal(f.get("worker:call", "thread-two").output, "exact:thread-two:worker:call")
  release()
})

test("exact null, empty, and error-marked outputs are preserved", async () => {
  for (const output of [null, "", 0, false, { array: [1, 2] }]) {
    const f = fixture(() => Promise.resolve({ output, is_error: true }))
    f.add("c")
    await f.cache.hydrate("t", "c")
    assert.strictEqual(f.get("c").output, output)
    assert.equal(f.get("c").outputOmitted, false)
    assert.equal(f.get("c").isError, true)
  }
})


test("live completions join the same bounded cache without fetching or duplicating payloads", async () => {
  const f = fixture()
  for (let i = 0; i < 100; i++) {
    f.add(`live${i}`, "t", { output: `exact live ${i}`, outputOmitted: false })
    f.cache.track("t", `live${i}`)
  }
  assert.equal(f.calls, 0)
  assert.equal([...f.blocks.values()].filter(b => !b.outputOmitted).length, 12)
  assert.equal(f.get("live99").output, "exact live 99")
  assert.equal(f.get("live0").outputOmitted, true)
  const release = f.cache.retain("t", "live0")
  await f.cache.hydrate("t", "live0")
  assert.equal(f.get("live0").output, "exact:t:live0")
  assert.equal(f.calls, 1)
  release()
})

test("large inactive outputs obey a byte budget while shared mounted output stays exact", () => {
  const f = fixture()
  const output = "é".repeat(MAX_INACTIVE_OUTPUT_BYTES / 2 + 1)
  f.add("visible", "t", { outputOmitted: false, output })
  const first = f.cache.retain("t", "visible")
  const second = f.cache.retain("t", "visible")
  f.cache.track("t", "visible")
  for (let i = 0; i < 20; i++) {
    f.add(`large${i}`, "t", { outputOmitted: false, output: "x".repeat(1024 * 1024) })
    f.cache.track("t", `large${i}`)
  }
  assert.strictEqual(f.get("visible").output, output)
  assert.equal(f.get("visible").outputOmitted, false)
  assert.equal([...f.blocks.values()].filter(b => !b.outputOmitted).length, 1)
  first(); first()
  assert.strictEqual(f.get("visible").output, output)
  second()
  assert.equal(f.get("visible").outputOmitted, true)
  assert.equal(f.calls, 0)
})

test("oversized reconstructible results leave the inactive LRU while open copies stay exact", async () => {
  const f = fixture()
  const output = "é".repeat(OVERSIZED_OUTPUT_BYTES / 2 + 1)
  assert.equal(toolOutputIsOversized(output.length * 2), true)
  f.add("open", "t", { outputOmitted: false, output })
  const release = f.cache.retain("t", "open")
  f.cache.track("t", "open")
  await loadInactive(f, 0, 12)
  assert.strictEqual(f.get("open").output, output)
  assert.equal([...f.blocks.values()].filter(b => !b.outputOmitted).length, 13)
  release()
  assert.equal(f.get("open").outputOmitted, true)
  assert.equal([...f.blocks.values()].filter(b => !b.outputOmitted).length, 12)
  f.add("offscreen", "t", { outputOmitted: false, output })
  f.cache.track("t", "offscreen")
  f.cache.drop("t", "offscreen")
  assert.equal(f.get("offscreen").outputOmitted, true)
  assert.equal([...f.blocks.values()].filter(b => !b.outputOmitted).length, 12)
})

test("an evicted live replacement cannot accept an obsolete hydration response", async () => {
  const pending = deferred(), f = fixture(() => pending.promise)
  f.add("replaced")
  const old = f.cache.hydrate("t", "replaced")
  await Promise.resolve()
  f.add("replaced", "t", { seq: 100, output: "live replacement", outputOmitted: false })
  f.cache.track("t", "replaced")
  for (let i = 0; i < 12; i++) {
    f.add(`new${i}`, "t", { output: "new", outputOmitted: false })
    f.cache.track("t", `new${i}`)
  }
  pending.resolve(response("obsolete")); await old
  assert.equal(f.get("replaced").outputOmitted, true)
  assert.equal(f.writes, 0)
})
