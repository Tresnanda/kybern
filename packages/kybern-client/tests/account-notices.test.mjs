import assert from "node:assert/strict"
import test from "node:test"

const { applyEvent, seedFromGet, emptyThreadState, prependThreadHistory } = await import("../src/transcript.ts")
const { accountNotice } = await import("../src/accountNotices.ts")

const AT = "2026-11-27T10:00:00Z"
const WORK = { kind: "claude-code", instance: "work" }
const HOME = { kind: "claude-code", instance: "default" }
const THREAD = { id: "t", project_id: "p", title: "Fix", provider: WORK, status: "idle", permission_mode: "supervised", cwd: "/tmp", pinned: false, created_at: AT, updated_at: AT, last_seq: 0 }

const event = (seq, payload) => ({ seq, thread_id: "t", turn_id: "turn-1", at: AT, ...payload })
const switched = (seq, from, to) => event(seq, { kind: "account_switched", from, to, reason: "limit", text: `Switched to ${to.instance}` })
const wait = (seq) => event(seq, { kind: "account_wait", until: "2026-11-27T15:00:00Z", account: WORK, text: "Waiting for Work to reset at 15:00" })
const ended = (seq, cancelled) => event(seq, { kind: "account_wait_ended", account: WORK, cancelled, text: cancelled ? "Stopped waiting" : "Continued on Work" })

const notices = (state) => state.blocks.filter((block) => block.kind === "notice")

test("a switch is one line that keeps what Undo needs", () => {
  const state = applyEvent(emptyThreadState(), switched(1, HOME, WORK))
  const [row] = notices(state)
  assert.equal(row.text, "Switched to work")
  assert.equal(row.turnId, "turn-1")
  assert.deepEqual(accountNotice(row.data), { kind: "account_switched", from: HOME, to: WORK, reason: "limit" })
})

test("only the newest switch stays offered", () => {
  let state = applyEvent(emptyThreadState(), switched(1, HOME, WORK))
  state = applyEvent(state, switched(2, WORK, HOME))
  const [first, second] = notices(state).map((row) => accountNotice(row.data))
  assert.equal(first.superseded, true)
  assert.equal(second.superseded, undefined)
})

test("the end of a wait replaces the waiting line and keeps its row", () => {
  let state = applyEvent(emptyThreadState(), wait(1))
  const before = notices(state)[0]
  state = applyEvent(state, ended(2, false))
  assert.equal(notices(state).length, 1)
  const after = notices(state)[0]
  assert.equal(after.id, before.id)
  assert.equal(after.text, "Continued on Work")
  assert.deepEqual(accountNotice(after.data), { kind: "account_wait_ended", account: WORK, cancelled: false })
  assert.equal(state.lastSeq, 2)
})

test("an end with no waiting line stands on its own", () => {
  const state = applyEvent(emptyThreadState(), ended(4, true))
  assert.equal(notices(state).length, 1)
  assert.equal(notices(state)[0].text, "Stopped waiting")
})

const entry = (seq, kind, extra, text) => ({ role: "notice", turn_id: "turn-1", seq, at: AT, level: "info", text, data: { kind, ...extra, text } })
const page = (transcript, next = null) => ({ thread: { ...THREAD, last_seq: 9 }, transcript, pending_approvals: [], next_before_seq: next })

test("a stored transcript folds the same way", () => {
  const state = seedFromGet(page([
    entry(1, "account_wait", { until: "2026-11-27T15:00:00Z", account: WORK }, "Waiting for Work"),
    entry(2, "account_wait_ended", { account: WORK, cancelled: true }, "Stopped waiting"),
    entry(3, "account_switched", { from: HOME, to: WORK, reason: "unavailable" }, "Switched to Work"),
  ]))
  assert.deepEqual(notices(state).map((row) => row.text), ["Stopped waiting", "Switched to Work"])
})

test("a wait on an older page folds with its end on the newer one", () => {
  const newer = seedFromGet(page([entry(5, "account_wait_ended", { account: WORK, cancelled: false }, "Continued on Work")], 4))
  const merged = prependThreadHistory(newer, page([entry(3, "account_wait", { until: "2026-11-27T15:00:00Z" }, "Waiting for Work")]), [])
  assert.deepEqual(notices(merged).map((row) => row.text), ["Continued on Work"])
})

test("other notices are untouched", () => {
  const state = seedFromGet(page([entry(1, "fork", { machine_id: "m" }, "Forked to fedora")]))
  assert.equal(accountNotice(notices(state)[0].data), null)
})
