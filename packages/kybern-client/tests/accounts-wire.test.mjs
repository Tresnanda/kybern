// The shared client fed with the account answers a daemon really sends (fixtures written by
// `crates/kybern-protocol/tests/accounts_wire.rs`). A Rust shape this code does not expect fails here, not in an app.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const { applyEvent, emptyThreadState } = await import("../src/transcript.ts")
const { accountNotice, foldAccountNotices } = await import("../src/accountNotices.ts")
const { brokerLine, loanLines, providerStatus, throughBroker } = await import("../src/loginBroker.ts")

const wire = (name) => JSON.parse(readFileSync(new URL(`./fixtures/accounts-wire/${name}.json`, import.meta.url), "utf8"))

test("every account event becomes its transcript line, with what Undo needs", () => {
  let state = emptyThreadState()
  for (const event of wire("account-events")) state = applyEvent(state, event)
  const notices = state.blocks.filter((block) => block.kind === "notice")
  const kinds = notices.map((row) => accountNotice(row.data)?.kind)
  // A wait and its end are one line.
  assert.deepEqual(kinds, ["account_switched", "account_switched", "account_wait_ended", "account_wait_ended"])
  const [first, second] = notices.map((row) => accountNotice(row.data))
  assert.equal(first.superseded, true, "only the newest switch offers Undo")
  assert.deepEqual(second.to, { kind: "claude-code", instance: "default" })
  assert.equal(second.reason, "unavailable")
  assert.equal(notices[0].text, "Switched to Personal")
  assert.deepEqual(foldAccountNotices(notices), notices)
})

test("every login broker status says something readable for every harness", () => {
  for (const status of wire("login-broker-status")) {
    for (const provider of status.providers) {
      const line = brokerLine(provider, status.broker?.name ?? undefined, "Claude")
      assert.ok(line.text && !line.text.includes("undefined"), JSON.stringify(line))
      assert.equal(typeof throughBroker(provider.state), "boolean")
    }
    assert.doesNotThrow(() => providerStatus(status, "claude-code"))
    const loans = loanLines(status, "claude-code", () => "MacBook", (iso) => iso)
    assert.equal(loans.length, status.is_broker ? status.loans.length : 0)
  }
})

test("every offer carries both lists, and every account row the fields clients read", () => {
  for (const offer of wire("offers").offers) {
    assert.ok(Array.isArray(offer.keys) && Array.isArray(offer.machines), offer.id)
    assert.equal(typeof offer.fingerprint, "string")
  }
  for (const account of wire("accounts-list").accounts) {
    assert.equal(typeof account.provider.kind, "string")
    assert.equal(typeof account.is_default, "boolean")
    assert.ok(Array.isArray(account.projects))
    if (account.key) assert.equal(account.key, `${account.provider.kind}:${account.identity.email.toLowerCase()}`)
  }
  const handoff = wire("account-logins").find((login) => login.handoff)
  assert.deepEqual(handoff.handoff, { port: 54321, path: "/callback" })
})
