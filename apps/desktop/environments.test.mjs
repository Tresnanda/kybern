import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { registerHooks } from "node:module"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { KybernClient } from "../../packages/kybern-client/src/client.ts"
import { PROTOCOL_VERSION } from "../../packages/kybern-client/src/types.ts"
import { normalizeDaemonUrl, pairingInvitation, parsePairingInvitation } from "../../packages/kybern-client/src/address.ts"

registerHooks({
  resolve(specifier, context, next) {
    const url = specifier.startsWith("@/") ? new URL("./src/" + specifier.slice(2), import.meta.url)
      : specifier.startsWith(".") && context.parentURL ? new URL(specifier, context.parentURL) : null
    if (url && !/\.[a-z]+$/i.test(url.pathname) && existsSync(fileURLToPath(url) + ".ts")) {
      return { shortCircuit: true, url: url.href + ".ts" }
    }
    return next(specifier, context)
  },
})
const storage = new Map()
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
  removeItem: (key) => storage.delete(key),
}
const stores = await import("./src/state/store.ts")

test("switching isolates drafts, selection, terminals, and late writes", async () => {
  const a = stores.activateEnvironmentStore("machine-a")
  a.getState().set({
    selected: { kind: "thread", id: "thread-a" },
    composerDrafts: { "thread:a": { text: "draft a", attachments: [], mentions: [], skills: [] } },
    terminalTabs: { "thread-a": [{ key: "terminal-a", title: "Shell", command: null }] },
  })
  let finish
  const pending = new Promise((resolve) => { finish = resolve }).then(() => a.getState().set({ projects: { "project-a": { id: "project-a" } } }))
  const b = stores.activateEnvironmentStore("machine-b")
  assert.deepEqual(b.getState().composerDrafts, {})
  assert.deepEqual(b.getState().terminalTabs, {})
  finish(); await pending
  assert.deepEqual(b.getState().projects, {})
  assert.equal(stores.activateEnvironmentStore("machine-a"), a)
  assert.equal(a.getState().composerDrafts["thread:a"].text, "draft a")
  const restored = stores.createEnvironmentStore("machine-a")
  assert.equal(restored.getState().selected.id, "thread-a")
  assert.equal(restored.getState().terminalTabs["thread-a"][0].key, "terminal-a")
  assert.deepEqual(stores.createEnvironmentStore("machine-b").getState().composerDrafts, {})
})

test("addresses preserve TLS default ports, proxy prefixes and IPv6", () => {
  assert.equal(normalizeDaemonUrl("build-server"), "ws://build-server:4173/ws")
  assert.equal(normalizeDaemonUrl("https://host.example/kybern"), "wss://host.example/kybern/ws")
  assert.equal(normalizeDaemonUrl("[::1]:4199"), "ws://[::1]:4199/ws")
  for (const invalid of ["file:///tmp", "https://user:password@host", "ws://host/ws?token=secret", ""]) {
    assert.throws(() => normalizeDaemonUrl(invalid))
  }
  const invitation = pairingInvitation("https://host.example", "123456", "machine-a")
  assert.deepEqual(parsePairingInvitation(invitation), { url: "wss://host.example/ws", code: "123456", environmentId: "machine-a" })
  assert.equal(parsePairingInvitation("kybern://pair?url=ws://host&token=secret"), null)
})

class Socket {
  readyState = 0
  sent = []
  onopen = null
  onmessage = null
  onclose = null
  onerror = null
  constructor(environmentId) { this.environmentId = environmentId }
  open() { this.readyState = 1; this.onopen?.() }
  frame(value) { this.onmessage?.({ data: JSON.stringify(value) }) }
  send(text) {
    const request = JSON.parse(text); this.sent.push(request)
    if (request.method === "daemon.info") queueMicrotask(() => this.reply(request, { protocol_version: PROTOCOL_VERSION, environment_id: this.environmentId }))
  }
  reply(request, result) { this.frame({ jsonrpc: "2.0", id: request.id, result }) }
  close() { this.readyState = 3 }
  interrupt() { this.readyState = 3; this.onclose?.({ code: 1006 }) }
}
const tick = () => new Promise((resolve) => setImmediate(resolve))
function fixture(expected = "machine-a", actual = expected) {
  const sockets = []
  const client = new KybernClient({ url: "ws://host/ws", token: "device-secret" }, {
    expectedEnvironmentId: expected, heartbeatMs: 1_000_000,
    createSocket() { const socket = new Socket(actual); sockets.push(socket); return socket },
  })
  return { client, sockets }
}

test("restored event history stops reconnecting and requests a fresh workspace", async () => {
  const { client, sockets } = fixture()
  client.subscribeEvents({ after_seq: 200 }, () => {})
  client.connect(); sockets[0].open(); await tick()
  const request = sockets[0].sent.find((r) => r.method === "events.subscribe")
  sockets[0].frame({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "cursor ahead of history" } })
  await tick()
  assert.equal(client.status, "failed")
  await client.checkConnection()
  assert.equal(sockets.length, 1)
  client.close()
})

test("identity is verified before an environment becomes usable", async () => {
  const { client, sockets } = fixture("machine-a", "machine-b")
  const statuses = []
  client.onStatus((status) => statuses.push(status))
  client.connect(); sockets[0].open(); await tick()
  assert.equal(client.status, "failed")
  assert.ok(!statuses.includes("open"))
  await assert.rejects(client.call("projects.list", {}))
  client.close()
})

test("disconnect rejects mutations and never resends them on reconnect", async () => {
  const { client, sockets } = fixture()
  try {
    client.connect(); sockets[0].open(); await tick()
    const send = client.call("threads.send", { thread_id: "thread-a", message: { parts: [] } })
    const rejected = assert.rejects(send, /interrupted/)
    sockets[0].interrupt(); await rejected
    await client.checkConnection(); sockets[1].open(); await tick()
    assert.equal(client.status, "open")
    assert.equal(sockets[0].sent.filter((r) => r.method === "threads.send").length, 1)
    assert.equal(sockets[1].sent.filter((r) => r.method === "threads.send").length, 0)
  } finally { client.close() }
})

test("reconnect replays from last delivered cursor and deduplicates events", async () => {
  const { client, sockets } = fixture()
  const seen = []
  try {
    client.subscribeEvents({ after_seq: 0 }, (event) => seen.push(event.seq))
    client.connect(); sockets[0].open(); await tick()
    let request = sockets[0].sent.find((r) => r.method === "events.subscribe")
    sockets[0].reply(request, { subscription_id: "sub-1", head_seq: 4 }); await tick()
    const event = (socket, id, seq) => socket.frame({ jsonrpc: "2.0", method: "event", params: { subscription_id: id, event: { seq, kind: "thread_archived", thread_id: "a" } } })
    event(sockets[0], "sub-1", 1); event(sockets[0], "sub-1", 2); event(sockets[0], "sub-1", 2)
    sockets[0].interrupt(); await client.checkConnection(); sockets[1].open(); await tick()
    request = sockets[1].sent.find((r) => r.method === "events.subscribe")
    assert.equal(request.params.after_seq, 2)
    sockets[1].reply(request, { subscription_id: "sub-2", head_seq: 4 }); await tick()
    event(sockets[1], "sub-2", 2); event(sockets[1], "sub-2", 3); event(sockets[1], "sub-2", 4)
    assert.deepEqual(seen, [1, 2, 3, 4])
  } finally { client.close() }
})

test("a closed environment ignores late handshake responses", async () => {
  const { client, sockets } = fixture()
  client.connect(); sockets[0].open(); client.close()
  await tick()
  assert.equal(client.status, "closed")
  assert.equal(client.info, null)
})
