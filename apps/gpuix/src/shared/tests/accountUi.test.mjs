import assert from "node:assert/strict"
import test from "node:test"
import { accountNeedsSignIn, cacheDotOpacity, cacheState, cacheValue, followLine, glyphAriaLabel, glyphTone, keepsAccount, nextTabIndex, pickerTabs } from "../lib/accountUi.ts"

const agents = [
  { kind: "claude-code", display_name: "Claude Code", available: true },
  { kind: "codex", display_name: "Codex", available: true },
  { kind: "pi", display_name: "Pi", available: false },
]
const acct = (kind, instance, name, extra = {}) => ({ provider: { kind, instance }, name, status: "signed_in", is_default: false, projects: [], managed: true, can_sign_out: true, ...extra })
const accounts = [
  acct("claude-code", "default", "CLI account", { is_default: true }),
  acct("claude-code", "work", "Work", { color: "blue" }),
  acct("claude-code", "arunika", "Arunika", { color: "green", status: "needs_sign_in" }),
  acct("codex", "default", "CLI account", { is_default: true }),
]
const base = { agents, accounts, current: { kind: "claude-code", instance: "work" }, canPickProvider: true, starredView: false }
const accountTabs = (tabs) => tabs.filter((t) => t.type === "account")

test("starred is the first tab; multi-account agents get one tab per account, CLI first", () => {
  const tabs = pickerTabs(base)
  assert.equal(tabs[0].type, "starred")
  assert.deepEqual(accountTabs(tabs).map((t) => t.key), ["claude-code:default", "claude-code:work", "claude-code:arunika", "codex:default", "pi:default"])
})

test("only the selected account of a multi-account agent shows a label", () => {
  const tabs = accountTabs(pickerTabs(base))
  assert.deepEqual(tabs.map((t) => t.label), [null, "Work", null, null, null])
  assert.equal(accountTabs(pickerTabs({ ...base, current: { kind: "claude-code", instance: "default" } }))[0].label, "CLI")
})

test("single-account agents keep one icon-only tab selected by kind", () => {
  const codex = accountTabs(pickerTabs({ ...base, current: { kind: "codex", instance: "default" } })).find((t) => t.kind === "codex")
  assert.equal(codex.selected, true)
  assert.equal(codex.label, null)
  assert.equal(codex.tooltip, "Codex")
})

test("the rail names an agent, or for a multi-account agent its accounts (\"Claude CLI\", not \"Claude Code CLI\")", () => {
  assert.deepEqual(accountTabs(pickerTabs(base)).map((t) => t.rail), ["Claude CLI", "Work", "Arunika", "Codex", "Pi"])
  // Display only: the keys and tooltips still carry the full names.
  assert.equal(accountTabs(pickerTabs(base))[0].key, "claude-code:default")
  assert.equal(accountTabs(pickerTabs(base))[0].tooltip, "Claude Code · CLI account")
  // A single-account agent keeps its own name.
  assert.equal(accountTabs(pickerTabs({ ...base, accounts: [] }))[0].rail, "Claude Code")
})

test("starred view deselects account tabs", () => {
  const tabs = pickerTabs({ ...base, starredView: true })
  assert.equal(tabs[0].selected, true)
  assert.equal(accountTabs(tabs).some((t) => t.selected), false)
})

test("a removed current account falls back to the CLI account", () => {
  const tabs = accountTabs(pickerTabs({ ...base, current: { kind: "claude-code", instance: "gone" } }))
  assert.equal(tabs.find((t) => t.selected).instance, "default")
})

test("tooltips and sign-in state", () => {
  const tabs = accountTabs(pickerTabs(base))
  assert.equal(tabs[0].tooltip, "Claude Code · CLI account")
  assert.equal(tabs[1].tooltip, "Claude Code · Work")
  assert.equal(tabs[2].tooltip, "Claude Code · Arunika — needs sign-in")
  assert.equal(tabs[2].needsSignIn, true)
  assert.equal(tabs[4].notSetUp, true)
  assert.equal(accountNeedsSignIn(acct("claude-code", "default", "CLI account", { status: "signed_out" })), false)
})

test("an omp account never asks for a sign-in: omp runs on the providers set up inside it", () => {
  assert.equal(accountNeedsSignIn(acct("omp", "work", "Work", { status: "signed_out" })), false)
  assert.equal(accountNeedsSignIn(acct("omp", "work", "Work", { status: "needs_sign_in" })), false)
  const omp = { kind: "omp", display_name: "Oh My Pi", available: true }
  const tabs = accountTabs(pickerTabs({ ...base, agents: [omp], accounts: [acct("omp", "default", "CLI account", { status: "signed_out" }), acct("omp", "work", "Work", { status: "signed_out" })], current: { kind: "omp", instance: "default" } }))
  assert.deepEqual(tabs.map((t) => t.needsSignIn), [false, false])
  assert.ok(tabs.every((t) => !/sign/i.test(t.tooltip) && !/sign/i.test(t.ariaLabel)))
})

test("without canPickProvider only other agents are disabled", () => {
  const tabs = accountTabs(pickerTabs({ ...base, canPickProvider: false }))
  assert.deepEqual(tabs.map((t) => t.disabled), [false, false, false, true, true])
})

test("arrow keys skip disabled tabs and wrap", () => {
  const tabs = [{}, { disabled: true }, {}, {}]
  assert.equal(nextTabIndex(tabs, 0, 1), 2)
  assert.equal(nextTabIndex(tabs, 3, 1), 0)
  assert.equal(nextTabIndex(tabs, 0, -1), 3)
})

test("follow line states", () => {
  const cur = { kind: "claude-code", instance: "work" }
  assert.equal(followLine({ accounts, current: cur, followsDefaults: undefined }), null)
  assert.equal(followLine({ accounts, current: { kind: "codex", instance: "default" }, followsDefaults: true }), null)
  assert.equal(followLine({ accounts, current: cur, followsDefaults: true }).text, "Following defaults · Work")
  const pinned = followLine({ accounts, current: cur, followsDefaults: false })
  assert.equal(pinned.text, "This thread uses Work")
  assert.equal(pinned.action, "Follow defaults")
  assert.equal(followLine({ accounts, current: { kind: "claude-code", instance: "default" }, followsDefaults: true }).text, "Following defaults · CLI account")
})

test("a thread that already ran says which account it uses, with no defaults to go back to", () => {
  const cur = { kind: "claude-code", instance: "work" }
  for (const followsDefaults of [true, false]) {
    const line = followLine({ accounts, current: cur, followsDefaults, kept: true })
    assert.deepEqual(line, { state: "kept", name: "Work", color: "blue", text: "This thread uses Work" })
  }
  assert.equal(followLine({ accounts, current: cur, followsDefaults: undefined, kept: true }), null)
})

test("a thread keeps its account once it ran, on a daemon that holds it there", () => {
  const work = { kind: "claude-code", instance: "work" }
  const ran = { provider: work, provider_session_id: "s1" }
  assert.equal(keepsAccount(ran, work, accounts, "0.27.2"), true)
  // Picking another account of the same agent, not sent yet: the thread still has no defaults to follow.
  assert.equal(keepsAccount(ran, { kind: "claude-code", instance: "default" }, accounts, "0.28.0"), true)
  assert.equal(keepsAccount({ provider: { kind: "claude-code", instance: "default" }, provider_session_id: "s1" }, work, [], "0.27.2"), true)
  // Never ran, or another agent is picked: it follows the defaults.
  assert.equal(keepsAccount({ provider: work, provider_session_id: null }, work, accounts, "0.27.2"), false)
  assert.equal(keepsAccount(ran, { kind: "codex", instance: "default" }, accounts, "0.27.2"), false)
  // Its account was removed: it follows the defaults again.
  assert.equal(keepsAccount({ provider: { kind: "claude-code", instance: "gone" }, provider_session_id: "s1" }, work, accounts, "0.27.2"), false)
  // An older daemon moves the thread with the default; an unknown one is not assumed to hold it.
  assert.equal(keepsAccount(ran, work, accounts, "0.27.1"), false)
  assert.equal(keepsAccount(ran, work, accounts, undefined), false)
})

test("glyph tone thresholds", () => {
  assert.equal(glyphTone(79, null), "normal")
  assert.equal(glyphTone(80, null), "warning")
  assert.equal(glyphTone(94, 50), "warning")
  assert.equal(glyphTone(95, 50), "critical")
  assert.equal(glyphTone(10, 20), "normal")
  assert.equal(glyphTone(10, 19), "warning")
  assert.equal(glyphTone(null, 5), "warning")
  assert.equal(glyphTone(96, 5), "critical")
})

test("cache dot", () => {
  assert.equal(cacheDotOpacity(cacheState(false, 0)), 0)
  assert.equal(cacheDotOpacity(cacheState(false, 1)), 0.5)
  assert.equal(cacheDotOpacity(cacheState(false, 4)), 1)
  assert.equal(cacheDotOpacity(cacheState(true, 0)), 1)
  assert.equal(cacheDotOpacity(null), 0)
  assert.equal(cacheValue(cacheState(false, 4)), "Warm · 4 min left")
  assert.equal(cacheValue(cacheState(true, 0)), "Active")
  assert.equal(cacheValue(cacheState(false, 0)), "Cold")
})

test("glyph aria label", () => {
  assert.equal(
    glyphAriaLabel({ contextPercent: 42, cache: { state: "warm", minutes: 4 }, account: { name: "Work", leftPercent: 18, windowLabel: "5-hour" } }),
    "Context 42% used. Prompt cache warm, about 4 minutes left. Work: 18% of the 5-hour limit left.",
  )
  assert.equal(glyphAriaLabel({ contextPercent: null, cache: null, account: null }), "Context usage unavailable.")
  assert.equal(glyphAriaLabel({ contextPercent: 5, cache: { state: "cold" }, account: null }), "Context 5% used. Prompt cache cold.")
})

test("on another machine only its installed agents are listed, and one signed out there says where", () => {
  const remoteAccounts = [acct("claude-code", "default", "CLI account", { is_default: true, status: "signed_out" }), acct("codex", "default", "CLI account", { is_default: true })]
  const tabs = accountTabs(pickerTabs({ agents, accounts: remoteAccounts, current: { kind: "codex", instance: "default" }, canPickProvider: true, starredView: false, machineName: "instabox" }))
  assert.deepEqual(tabs.map((t) => t.key), ["claude-code:default", "codex:default"])
  assert.equal(tabs[0].needsSignIn, true)
  assert.equal(tabs[0].signedOutOn, "instabox")
  assert.equal(tabs[0].tooltip, "Claude Code · signed out on instabox")
  assert.equal(tabs[1].needsSignIn, false)
  // On this machine nothing changes: the CLI account is never "needs sign-in", and an agent that is not installed still shows as not set up.
  const here = accountTabs(pickerTabs({ agents, accounts: remoteAccounts, current: { kind: "codex", instance: "default" }, canPickProvider: true, starredView: false }))
  assert.deepEqual([here.length, here[0].needsSignIn, here[2].notSetUp], [3, false, true])
})

test("agents that aren't installed sort after the installed ones, each group keeping its order", () => {
  const mixed = [
    { kind: "pi", display_name: "Pi", available: false },
    { kind: "claude-code", display_name: "Claude Code", available: true },
    { kind: "cursor", display_name: "Cursor", available: false },
    { kind: "codex", display_name: "Codex", available: true },
  ]
  const tabs = accountTabs(pickerTabs({ ...base, agents: mixed, accounts: [], current: { kind: "codex", instance: "default" } }))
  assert.deepEqual(tabs.map((t) => t.kind), ["claude-code", "codex", "pi", "cursor"])
  assert.deepEqual(tabs.map((t) => t.notSetUp), [false, false, true, true])
  // Favorites stays first.
  assert.equal(pickerTabs({ ...base, agents: mixed, accounts: [] })[0].type, "starred")
})
