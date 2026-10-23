import assert from "node:assert/strict"
import test from "node:test"

import {
  askDeadlineOptions,
  autoAnswer,
  changeAnswerMessage,
  deadlineState,
  defaultOption,
  formatCountdown,
  loginRequestInput,
  passwordCopy,
  passwordMeta,
  permissionRequestInput,
  permissionStillOffMeta,
  permissionTitle,
  promptRequestInput,
  questionDeadline,
  recordText,
  requestRecord,
  shortUrl,
  waitText,
  wrongAnswerError,
} from "../src/requestCards.ts"

const approval = (tool_name, input) => ({ id: "a1", thread_id: "t1", tool_name, input, summary: "", suggestions: [], created_at: "2026-10-23T00:00:00Z" })
const LOGIN = { cli: "gh", service: "GitHub", reason: "To open the pull request.", account: "github.com, any account you choose", access: "repo, read:org, workflow", signs_in: "`gh` for this Mac", command: "gh auth login", methods: ["browser", "terminal"] }
const SUDO = { purpose: "sudo", prompt: "[sudo] password for mymac:", secret: true, confirm: false, command: "sudo brew services start postgresql@17", harness: "Claude Code", attempt: 1, wait_seconds: 300 }
const HOST = { purpose: "ssh_host_key", prompt: "Are you sure?", secret: false, confirm: true, command: "ssh deploy@203.0.113.24", harness: "Codex", host: "203.0.113.24", key_type: "ED25519", fingerprint: "SHA256:abc", attempt: 1, wait_seconds: 300 }
const CAMERA = { pane: "camera", app: "Anamorphia", bundle_id: "com.anamorphia.gallery", reason: "To test capture.", pane_label: "Privacy & Security › Camera", url: "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera", needs_app_added: false, relaunch: false, detects: true }

test("reads each card's input and rejects other tools", () => {
  assert.equal(loginRequestInput(approval("kybern_request_login", LOGIN))?.service, "GitHub")
  assert.deepEqual(loginRequestInput(approval("kybern_request_login", { cli: "eas" }))?.methods, ["browser", "terminal"])
  assert.equal(loginRequestInput(approval("Bash", LOGIN)), null)
  assert.equal(promptRequestInput(approval("kybern_askpass", SUDO))?.attempt, 1)
  assert.equal(promptRequestInput(approval("kybern_askpass", { ...SUDO, attempt: 0 }))?.attempt, 1)
  assert.equal(permissionRequestInput(approval("kybern_request_permission", CAMERA))?.detects, true)
  assert.equal(permissionRequestInput(approval("kybern_request_permission", {})), null)
})

test("a deadline only on AskUserQuestion with a valid end", () => {
  const deadline = { defaults: { "Where?": "In a row" }, seconds: 600, started_at: "2026-10-23T01:50:00Z", ends_at: "2026-10-23T02:00:00Z" }
  assert.equal(questionDeadline(approval("AskUserQuestion", { questions: [], deadline }))?.seconds, 600)
  assert.equal(questionDeadline(approval("AskUserQuestion", { questions: [] })), null)
  assert.equal(questionDeadline(approval("Bash", { deadline })), null)
  assert.equal(questionDeadline(approval("AskUserQuestion", { deadline: { ...deadline, ends_at: "soon" } })), null)
})

test("password copy per purpose", () => {
  assert.equal(passwordCopy(SUDO).title, "Enter your Mac password for sudo")
  assert.equal(passwordCopy({ purpose: "ssh_passphrase", confirm: false }).glyph, "key")
  assert.equal(passwordCopy(HOST).title, "Trust this server?")
  assert.equal(passwordCopy({ purpose: "git_username", confirm: false, host: "git.example.net" }).title, "Sign in to git.example.net")
  assert.equal(passwordCopy({ purpose: "git_password", confirm: false, host: null }).label, "Password or access token")
  assert.equal(passwordMeta(SUDO, "Install the Postgres service"), "Claude Code asked in “Install the Postgres service”. Kybern never answers this on its own, even in Full access.")
  assert.match(passwordMeta(HOST, null), /^This Mac has never connected to 203\.0\.113\.24\./)
})

test("wrong password: tries left for sudo only", () => {
  assert.equal(wrongAnswerError(SUDO), null)
  assert.equal(wrongAnswerError({ ...SUDO, attempt: 2 }), "That password didn't work. sudo allows 2 more tries.")
  assert.equal(wrongAnswerError({ ...SUDO, attempt: 3 }), "That password didn't work. sudo allows 1 more try.")
  assert.equal(wrongAnswerError({ ...SUDO, attempt: 5 }), "That password didn't work. Check it and try again.")
  assert.equal(wrongAnswerError({ purpose: "ssh_passphrase", confirm: false, attempt: 2 }), "That didn't work. Try again.")
})

test("permission copy", () => {
  assert.equal(permissionTitle(CAMERA), "Let Anamorphia use the camera")
  assert.equal(permissionStillOffMeta({ ...CAMERA, relaunch: true }), "In Privacy & Security › Camera, turn on Anamorphia. macOS applies it after Anamorphia restarts.")
  assert.match(permissionStillOffMeta({ ...CAMERA, needs_app_added: true }), /add Anamorphia with \+/)
})

test("countdown text and state", () => {
  assert.equal(formatCountdown(581_000), "9:41")
  assert.equal(formatCountdown(42_001), "0:43")
  assert.equal(formatCountdown(0), "0:00")
  assert.equal(formatCountdown(-5), "0:00")
  assert.equal(formatCountdown(3_723_000), "1:02:03")
  const deadline = { defaults: {}, seconds: 600, started_at: "2026-10-23T01:50:00Z", ends_at: "2026-10-23T02:00:00Z" }
  const now = Date.parse("2026-10-23T01:55:00Z")
  assert.deepEqual(deadlineState(deadline, null, now), { phase: "running", remainingMs: 300_000, fraction: 0.5 })
  assert.equal(deadlineState(deadline, { phase: "asking", ends_at: "2026-10-23T02:01:00Z" }, now).remainingMs, 360_000)
  assert.deepEqual(deadlineState(deadline, { phase: "paused", remaining_ms: 120_000 }, now), { phase: "paused", remainingMs: 120_000, fraction: 0.2 })
  assert.equal(deadlineState(deadline, { phase: "held" }, now).phase, "held")
  assert.equal(deadlineState(deadline, null, Date.parse("2026-10-23T03:00:00Z")).remainingMs, 0)
})

test("default option and the follow-up message", () => {
  const deadline = { defaults: { "Where?": "In a row" }, seconds: 60, started_at: "x", ends_at: "y" }
  assert.equal(defaultOption(deadline, { title: "Where?", options: [{ label: "In the header" }, { label: "In a row" }] }), 1)
  assert.equal(defaultOption(deadline, { title: "Other?", options: [{ label: "In a row" }] }), -1)
  assert.equal(defaultOption(null, { title: "Where?", options: [] }), -1)
  assert.equal(changeAnswerMessage("Where?", "In a row", "In the header"), "I'd rather have “In the header” for “Where?” instead of “In a row”.")
})

test("records: sign-in", () => {
  const a = approval("kybern_request_login", LOGIN)
  assert.equal(recordText(requestRecord(a, { decision: "submit", response: { status: "signed_in", cli: "gh", service: "GitHub", account: "Tresnanda" } })), "Signed in to GitHub as Tresnanda · gh, repo, read:org, workflow")
  assert.equal(recordText(requestRecord(a, { decision: "submit", response: { status: "already_signed_in", cli: "gh", account: "Tresnanda" } })), "Already signed in to GitHub as Tresnanda")
  assert.equal(recordText(requestRecord(a, { decision: "deny", reason: "declined" })), "You declined to sign in to GitHub")
  assert.equal(recordText(requestRecord(a, { decision: "deny", reason: "timed out" })), "The sign-in to GitHub timed out.")
  assert.equal(requestRecord(a, null).tone, "pending")
  assert.equal(requestRecord(a, null, false).tone, "ended")
})

test("records: password prompt never shows a value", () => {
  const a = approval("kybern_askpass", SUDO)
  const sent = requestRecord(a, { decision: "submit", response: { secret: "[redacted]" } })
  assert.equal(recordText(sent), "Sent your password to sudo brew services start postgresql@17 · used once")
  assert.ok(!recordText(sent).includes("redacted"))
  const git = approval("kybern_askpass", { ...SUDO, purpose: "git_username", secret: false, command: "git push" })
  assert.ok(!recordText(requestRecord(git, { decision: "submit", response: { value: "tresnanda" } })).includes("tresnanda"))
  assert.equal(recordText(requestRecord(approval("kybern_askpass", { ...SUDO, command: "git push" }), { decision: "deny" })), "You cancelled the password prompt. git push failed.")
  assert.equal(recordText(requestRecord(approval("kybern_askpass", { ...SUDO, purpose: "ssh_passphrase", command: "git push" }), { decision: "deny", reason: "timed out" })), "Nobody answered the passphrase prompt in 5 min. git push failed.")
  assert.equal(recordText(requestRecord(approval("kybern_askpass", HOST), { decision: "submit", response: { confirmed: true } })), "Trusted 203.0.113.24 (ED25519) and added it to ~/.ssh/known_hosts")
  assert.equal(recordText(requestRecord(approval("kybern_askpass", HOST), { decision: "submit", response: { confirmed: false } })), "Didn't connect to 203.0.113.24. ssh deploy@203.0.113.24 failed.")
})

test("records: permission", () => {
  const a = approval("kybern_request_permission", CAMERA)
  assert.equal(recordText(requestRecord(a, { decision: "submit", response: { status: "granted", pane: "camera", app: "Anamorphia" } })), "Anamorphia can use the camera · turned on in System Settings")
  assert.equal(recordText(requestRecord(a, { decision: "submit", response: { status: "stopped" } })), "Stopped waiting for Anamorphia to get Camera")
  assert.equal(recordText(requestRecord(a, { decision: "deny" })), "Declined to let Anamorphia use the camera")
})

test("records: a question the deadline answered", () => {
  const a = approval("AskUserQuestion", { questions: [{ question: "Where?", options: [] }] })
  const decision = { decision: "submit", response: { answers: { "Where?": "In a 32 px row" }, auto: { at: "2026-10-23T02:00:00Z", waited_seconds: 600 } } }
  assert.deepEqual(autoAnswer(decision)?.answers, { "Where?": "In a 32 px row" })
  const text = recordText(requestRecord(a, decision, true, "en-GB"))
  assert.match(text, /^Chose “In a 32 px row” automatically at \d\d:\d\d · no answer within 10 min$/)
  assert.equal(requestRecord(a, { decision: "submit", response: { answers: { "Where?": "x" } } }), null)
  assert.equal(requestRecord(approval("Bash", {}), { decision: "allow_once" }), null)
})

test("small formatting helpers", () => {
  assert.equal(shortUrl("https://github.com/login/device"), "github.com/login/device")
  assert.equal(shortUrl("not a url"), "not a url")
  assert.equal(waitText(45), "45 s")
  assert.equal(waitText(5400), "1 h 30 min")
  assert.deepEqual(askDeadlineOptions(900).map((o) => o.label), ["5 minutes", "10 minutes", "15 minutes", "30 minutes", "1 hour", "4 hours"])
  assert.equal(askDeadlineOptions(1200).length, 7)
})
