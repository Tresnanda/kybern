import assert from "node:assert/strict"
import test from "node:test"
import {
  createResponseImageUrls,
  previewFitSize,
  PREVIEW_MAX_HEIGHT,
  PREVIEW_MAX_WIDTH,
  resetResponseImageUrls,
  responseImageUrlKey,
} from "./src/lib/responseImageUrls.ts"

const png = new Blob(["image"], { type: "image/png" })

test("preview fit never upscales and matches the daemon pixel budget", () => {
  assert.deepEqual(previewFitSize(1800, 600), { width: 560, height: 187 })
  assert.deepEqual(previewFitSize(600, 1800), { width: 117, height: 352 })
  assert.deepEqual(previewFitSize(80, 40), { width: 80, height: 40 })
  assert.equal(PREVIEW_MAX_WIDTH, 560)
  assert.equal(PREVIEW_MAX_HEIGHT, 352)
})

test("image URL keys keep thread, source, and preview/original variants distinct", () => {
  assert.notEqual(responseImageUrlKey("t", "/a.png", "preview"), responseImageUrlKey("t", "/a.png", "original"))
  assert.notEqual(responseImageUrlKey("t1", "/a.png", "preview"), responseImageUrlKey("t2", "/a.png", "preview"))
})

test("consumers share one object URL and the last release revokes it", async () => {
  const created = [], revoked = []
  const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL)
  URL.createObjectURL = (blob) => { const url = create(blob); created.push(url); return url }
  URL.revokeObjectURL = (url) => { revoked.push(url); revoke(url) }
  const urls = createResponseImageUrls()
  try {
    let loads = 0
    const load = async () => { loads++; return png }
    const first = await urls.acquire("k", load, new AbortController().signal)
    const second = await urls.acquire("k", load, new AbortController().signal)
    assert.equal(loads, 1)
    assert.equal(first.owned, true)
    assert.equal(first.url, second.url)
    assert.equal(urls.stats().live, 1)
    urls.release("k")
    assert.equal(revoked.length, 0)
    urls.release("k")
    assert.deepEqual(revoked, created)
    assert.equal(urls.stats().live, 0)
    assert.equal(urls.stats().idle, 1)
  } finally {
    urls.dispose()
    URL.createObjectURL = create
    URL.revokeObjectURL = revoke
  }
})

test("cancelling the last waiter aborts the load and does not keep a live URL", async () => {
  const urls = createResponseImageUrls()
  try {
    let started = 0, aborted = false
    const load = (signal) => {
      started++
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => { aborted = true; reject(Object.assign(new Error("aborted"), { name: "AbortError" })) })
      })
    }
    const controller = new AbortController()
    const pending = urls.acquire("slow", load, controller.signal)
    await Promise.resolve()
    assert.equal(started, 1)
    controller.abort()
    await assert.rejects(pending)
    assert.equal(aborted, true)
    assert.equal(urls.stats().live, 0)
    assert.equal(urls.stats().inflight, 0)
  } finally {
    urls.dispose()
  }
})

test("a remaining waiter keeps the in-flight load when another consumer cancels", async () => {
  const urls = createResponseImageUrls()
  try {
    let resolveLoad
    const load = () => new Promise((resolve) => { resolveLoad = resolve })
    const first = new AbortController(), second = new AbortController()
    const pending = urls.acquire("shared", load, first.signal)
    const other = urls.acquire("shared", load, second.signal)
    await Promise.resolve()
    first.abort()
    await assert.rejects(pending)
    resolveLoad(png)
    const acquired = await other
    assert.equal(acquired.owned, true)
    assert.equal(urls.stats().live, 1)
    urls.release("shared")
  } finally {
    urls.dispose()
  }
})

test("abort after the blob loads parks it instead of keeping a live URL", async () => {
  const urls = createResponseImageUrls()
  try {
    let resolveLoad
    const load = () => new Promise((resolve) => { resolveLoad = resolve })
    const controller = new AbortController()
    const pending = urls.acquire("k", load, controller.signal)
    await Promise.resolve()
    resolveLoad(png)
    controller.abort()
    await assert.rejects(pending)
    assert.equal(urls.stats().live, 0)
    assert.equal(urls.stats().idle, 1)
    assert.equal(urls.stats().inflight, 0)
    const again = await urls.acquire("k", async () => { throw new Error("should reopen from idle") }, new AbortController().signal)
    assert.equal(again.owned, true)
    urls.release("k")
  } finally {
    urls.dispose()
  }
})

test("reopening uses the idle blob instead of loading again", async () => {
  const urls = createResponseImageUrls()
  try {
    let loads = 0
    const load = async () => { loads++; return png }
    const first = await urls.acquire("k", load, new AbortController().signal)
    urls.release("k")
    const again = await urls.acquire("k", load, new AbortController().signal)
    assert.equal(loads, 1)
    assert.equal(again.url !== first.url, true)
    assert.equal(urls.stats().idle, 0)
    urls.release("k")
  } finally {
    urls.dispose()
  }
})

test("idle image blobs use their own 8 MiB / 12-entry budget", async () => {
  const urls = createResponseImageUrls({ maxIdleBytes: 20, maxIdleEntries: 2 })
  try {
    for (const key of ["a", "b", "c"]) {
      await urls.acquire(key, async () => new Blob(["1234567890"], { type: "image/png" }), new AbortController().signal)
      urls.release(key)
    }
    assert.equal(urls.stats().live, 0)
    assert.equal(urls.stats().idle, 2)
    assert.ok(urls.stats().idleBytes <= 20)
  } finally {
    urls.dispose()
  }
})

test("preview pass-through keeps the original source when the blob already fits", async () => {
  const urls = createResponseImageUrls({ fitPreview: async (blob) => blob })
  try {
    const source = "data:image/png;base64,YQ=="
    const acquired = await urls.acquire("inline", async () => png, new AbortController().signal, true, source)
    assert.equal(acquired.owned, false)
    assert.equal(acquired.url, source)
    urls.release("inline")
    const again = await urls.acquire("inline", async () => { throw new Error("should reopen from idle") }, new AbortController().signal, true, source)
    assert.equal(again.url, source)
    urls.release("inline")
  } finally {
    urls.dispose()
  }
})

test("resized previews become owned object URLs and stay off the original source", async () => {
  const resized = new Blob(["small"], { type: "image/png" })
  const urls = createResponseImageUrls({ fitPreview: async () => resized })
  try {
    const source = "data:image/png;base64,YQ=="
    const acquired = await urls.acquire("inline", async () => png, new AbortController().signal, true, source)
    assert.equal(acquired.owned, true)
    assert.notEqual(acquired.url, source)
    urls.release("inline")
  } finally {
    urls.dispose()
  }
})

test("resetting the module cache revokes live URLs", async () => {
  resetResponseImageUrls()
  const { acquireResponseImageUrl, releaseResponseImageUrl, responseImageUrlStats, resetResponseImageUrls: reset } = await import("./src/lib/responseImageUrls.ts")
  const acquired = await acquireResponseImageUrl("module", async () => png, new AbortController().signal)
  assert.equal(acquired.owned, true)
  assert.equal(responseImageUrlStats().live, 1)
  reset()
  assert.equal(responseImageUrlStats().live, 0)
  releaseResponseImageUrl("module")
})
