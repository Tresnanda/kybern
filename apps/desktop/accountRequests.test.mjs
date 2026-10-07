import assert from "node:assert/strict"
import test from "node:test"
import { AccountRequestSequence, refreshComposerCatalog } from "./src/state/accountRequests.ts"

const scope = { threadId: "thread", environmentId: "environment", settings: {} }
const provider = { kind: "claude-code", instance: "work-account" }
const status = { kind: "claude-code", models: [{ id: "account-model" }] }

test("initial hydration and slow B responses cannot replace the latest C selection", async () => {
  const requests = new AccountRequestSequence()
  const initial = requests.read(scope)
  const first = requests.select(scope)
  const last = requests.select(scope)
  const accepted = []
  const apply = (request, value) => { if (requests.finish(request)) accepted.push(value) }
  apply(last, "C")
  apply(first, "B")
  apply(initial, "initial A")
  assert.deepEqual(accepted, ["C"])
})

test("background hydration waits for an explicit selection and a failed latest selection can reconcile", () => {
  const requests = new AccountRequestSequence()
  const selection = requests.select(scope)
  assert.equal(requests.read(scope), null)
  assert.equal(requests.finish(selection), true)
  const reconcile = requests.read(scope)
  assert.ok(reconcile)
  const newer = requests.select(scope)
  assert.equal(requests.accepts(reconcile), false)
  assert.equal(requests.finish(selection), false)
  assert.equal(requests.finish(newer), true)
})

test("requests from the previous thread, environment, or settings are discarded", () => {
  for (const nextScope of [
    { ...scope, threadId: "another-thread" },
    { ...scope, environmentId: "another-environment" },
    { ...scope, settings: {} },
  ]) {
    const requests = new AccountRequestSequence()
    const old = requests.select(scope)
    const current = requests.read(nextScope)
    assert.ok(current)
    assert.equal(requests.finish(old), false)
    assert.equal(requests.accepts(current), true)
  }
})

test("explicit reload refreshes the selected account and never reads the global account catalog", async () => {
  const calls = []
  let globalCalls = 0
  const selected = await refreshComposerCatalog(provider, "project", true,
    async (account, force) => { calls.push({ account, force }); return status },
    async () => { globalCalls++; return [] })
  assert.deepEqual(calls, [{ account: provider, force: true }])
  assert.equal(globalCalls, 0)
  assert.equal(selected.models[0].id, "account-model")
})

test("silent account refresh preserves native cache policy and other composers keep their generic fallback", async () => {
  let force
  await refreshComposerCatalog(provider, "project", false,
    async (_, value) => { force = value; return status }, async () => [])
  assert.equal(force, false)
  let project
  const fallback = await refreshComposerCatalog(provider, "draft-project", true, undefined,
    async (value) => { project = value; return [status] })
  assert.equal(project, "draft-project")
  assert.equal(fallback, status)
})
