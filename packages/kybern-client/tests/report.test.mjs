// #235: "Report a problem" opens a prefilled issue on a public repository. What reaches it has no paths, user names, computer names,
// e-mail addresses or credentials.
import test from "node:test";
import assert from "node:assert/strict";
import { REPORT_REPO_URL, buildProblemReport, redactForReport, reportIssueUrl } from "../src/report.ts";
import { describeProblem } from "../src/problems.ts";

const NAMES = { users: ["bagus"], machines: ["Treshnandas-Macbook.local", "SatyaMas"] };
const redact = (text) => redactForReport(text, NAMES);

test("home folders and every other local path are stripped, on each OS", () => {
  const cases = [
    ["failed to read C:\\Users\\bagus\\projects\\kybern\\.env", "failed to read <path>"],
    ["open C:/Users/bagus/AppData/Local/Temp/x.log: denied", "open <path> denied"],
    ["at \\\\?\\D:\\kybern\\work\\errors\\src\\main.rs:10", "at <path>"],
    ["share \\\\fileserver\\public\\notes.txt unreachable", "share <path> unreachable"],
    ["ENOENT: no such file '/Users/bagus/Library/Application Support/Kybern/state.sqlite'", "ENOENT: no such file '<path>'"],
    ["cwd=/home/bagus/code/app", "cwd=<path>"],
    ["wrote /tmp/kyb/daemon.port and /var/folders/ab/cd/T/x", "wrote <path> and <path>"],
    ["config at ~/.kybern/settings.json", "config at <path>"],
    ["mounted /Volumes/Backup/photos", "mounted <path>"],
  ];
  for (const [input, expected] of cases) assert.equal(redact(input), expected, input);
});

test("what is not a local path is left alone", () => {
  for (const text of [
    "https://github.com/Tresnanda/kybern/issues/1",
    "GET /api/threads failed with 500",
    "git checkout feat/errors-p6",
    "src/problems/report.ts line 12",
    "Couldn't load pull requests",
  ])
    assert.equal(redact(text), text);
});

test("the user name and the names of computers are stripped wherever they appear", () => {
  assert.equal(redact("signed in as Bagus on Treshnandas-Macbook.local"), "signed in as <user> on <machine>");
  assert.equal(redact("SatyaMas is offline; satyamas did not answer"), "<machine> is offline; <machine> did not answer");
  // A name inside a longer word is not a name.
  assert.equal(redact("bagusan and subagus"), "bagusan and subagus");
  // Names that would mangle ordinary words are never used.
  assert.equal(redactForReport("the user root can admin this", { users: ["root", "admin", "us"] }), "the user root can admin this");
});

test("e-mail addresses are stripped", () => {
  assert.equal(redact("git config user.email treshnanda@gmail.com failed"), "git config user.email <email> failed");
  assert.equal(redact("From: Some One <some.one+kybern@example.co.id>"), "From: Some One <<email>>");
});

test("tokens, keys, passwords and credentials in URLs are stripped", () => {
  const github = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
  const pat = "github_pat_" + "11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const anthropic = "sk-ant-" + "api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF";
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r";
  const cases = [
    [`remote: ${github}`, "remote: <secret>"],
    [`token ${pat} rejected`, "token <secret> rejected"],
    [`ANTHROPIC_API_KEY=${anthropic}`, "ANTHROPIC_API_KEY=<secret>"],
    [`Authorization: Bearer ${jwt}`, "Authorization: <secret>"],
    ["retry with Bearer abcdef123456 now", "retry with Bearer <secret> now"],
    ['{"access_token":"abc123def456","name":"x"}', '{"access_token":"<secret>","name":"x"}'],
    ["password: hunter2", "password: <secret>"],
    ["cloning https://bagus:s3cret@github.com/Tresnanda/kybern.git", "cloning https://<secret>@github.com/Tresnanda/kybern.git"],
    ["open kybern://pair?url=http%3A%2F%2F192.168.1.4%3A4173&code=123456&environment=e", "open <pairing link>"],
    ["AKIA" + "IOSFODNN7EXAMPLE in env", "<secret> in env"],
    ["key " + "q8Zk2Vn7XpL4mR9tY3bW6cD1fH5jA0sGeUiOoKxCvBn" + " pasted", "key <secret> pasted"],
    ["-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----", "<secret>"],
  ];
  for (const [input, expected] of cases) assert.equal(redact(input), expected, input);
});

test("ids and hashes that help a report survive", () => {
  const text = "thread 0194a5c0-7d1e-7a3b-9c2d-1f4e5a6b7c8d at 3f786850e387550fdab836ed7e6dc881de23001b, version 0.19.0";
  assert.equal(redact(text), text);
});

test("network addresses that identify a computer are stripped, localhost is not", () => {
  assert.equal(redact("connect 192.168.1.20:4173 and 100.64.0.7 failed"), "connect <address> and <address> failed");
  assert.equal(redact("satya-pc.tail1234.ts.net timed out"), "<address> timed out");
  assert.equal(redact("listening on 127.0.0.1:4199"), "listening on 127.0.0.1:4199");
});

test("redacting twice changes nothing more", () => {
  const once = redact("C:\\Users\\bagus\\x.txt token=abcd1234efgh treshnanda@gmail.com SatyaMas 10.0.0.5");
  assert.equal(redact(once), once);
});

const ENV = { app: "0.19.0", daemon: "0.19.0", os: "Windows 10.0.26300", arch: "x64" };

test("the report has a title from the headline, then the kind, the subject, the technical detail and the environment", () => {
  const view = describeProblem(new Error("run gh: program not found"), { action: "load pull requests" });
  const report = buildProblemReport(view, ENV, NAMES);
  assert.equal(report.title, "Install GitHub CLI to load pull requests");
  assert.equal(
    report.body,
    ["**What I was doing**", "", "", "**Problem**", "- tool_missing: gh", "", "**Technical detail**", "```", "run gh: program not found", "```", "", "**This computer**", "- Kybern 0.19.0, daemon 0.19.0", "- Windows 10.0.26300 x64"].join("\n"),
  );
});

test("a report written from a real failure has no path, user, machine, e-mail or token left", () => {
  const detail = [
    "github.pr.list: run gh: C:\\Users\\bagus\\scoop\\shims\\gh.exe failed",
    "  cwd /Users/bagus/projects/kybern on Treshnandas-Macbook.local (SatyaMas)",
    "  git config user.email = treshnanda@gmail.com",
    "  GH_TOKEN=ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8",
  ].join("\n");
  const error = Object.assign(new Error("Couldn't list pull requests for bagus"), { data: { problem: { kind: "internal", detail, retryable: true } } });
  const report = buildProblemReport({ ...describeProblem(error, { action: "load pull requests" }), title: "Couldn't load pull requests for bagus" }, { ...ENV, os: "macOS /Users/bagus" }, NAMES);
  const everything = `${report.title}\n${report.body}`;
  for (const secret of ["bagus", "C:\\Users", "/Users", "Treshnandas", "SatyaMas", "treshnanda@gmail.com", "ghp_", "gmail"])
    assert.ok(!everything.toLowerCase().includes(secret.toLowerCase()), `${secret} reached the report:\n${everything}`);
  assert.match(everything, /<path>/);
  assert.match(everything, /<email>/);
  assert.match(everything, /<secret>/);
  assert.equal(report.title, "Couldn't load pull requests for <user>");
});

test("a machine's name is never the subject of a report", () => {
  const offline = buildProblemReport({ kind: "offline", subject: "Kitchen iMac", title: "Kitchen iMac is offline", detail: "Kitchen iMac is offline. Try again when it reconnects." }, ENV, {});
  assert.match(offline.body, /- offline: <machine>\n/);
  const named = buildProblemReport({ kind: "tool_missing", subject: "SatyaMas", title: "x", detail: "" }, {}, NAMES);
  assert.match(named.body, /- tool_missing: <machine>\n/);
});

test("a long technical text is cut in the middle, and backticks cannot close the code block", () => {
  const detail = `first line\n${"x ".repeat(2000)}\nlast line with a fence \`\`\` inside`;
  const { body } = buildProblemReport({ kind: "internal", title: "Couldn't do it", detail }, {}, {});
  assert.match(body, /first line/);
  assert.match(body, /last line with a fence/);
  assert.match(body, /\n\[…\]\n/);
  assert.ok(body.length < 2600, String(body.length));
  assert.match(body, /\n````\nfirst line/, "a longer fence than the text's own backticks");
});

test("the address opens a new issue with the title and body, and stays short enough for GitHub", () => {
  const url = new URL(reportIssueUrl({ title: "Couldn't load pull requests", body: "line one\nline two & more" }));
  assert.equal(`${url.origin}${url.pathname}`, `${REPORT_REPO_URL}/issues/new`);
  assert.equal(url.searchParams.get("title"), "Couldn't load pull requests");
  assert.equal(url.searchParams.get("body"), "line one\nline two & more");
  const long = reportIssueUrl({ title: "t", body: "é".repeat(6000) });
  assert.ok(long.length <= 7000, String(long.length));
  assert.match(new URL(long).searchParams.get("body"), /cut to fit the address/);
});
