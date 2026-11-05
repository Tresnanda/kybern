import assert from "node:assert/strict";
import test from "node:test";
import { RpcCallError } from "../../../packages/kybern-client/src/client.ts";
import { OfflineError } from "../../../packages/kybern-client/src/machineClient.ts";
import { problemLook, problemModel, problemText, prProblemModel, sentenceOf } from "../src/state/problems.ts";

const rpc = (code, message, data) => new RpcCallError({ code, message, ...(data ? { data } : {}) });
const JARGON = /RpcCallError|invalid params|not found:|os error|exit code|EPERM|EACCES|[A-Za-z]:\\|\/Users\/|program not found|Error:|^run \w+/i;

test("a missing tool is fixed on the computer, by name, and the button checks again", () => {
  const model = problemModel(rpc(-32602, "run gh: program not found"), { action: "load pull requests", machine: "SatyaMas" });
  assert.equal(model.kind, "tool_missing");
  assert.equal(model.title, "Install GitHub CLI to load pull requests");
  assert.equal(model.body, "Install it on SatyaMas, then check again.");
  assert.deepEqual(model.actions, [{ id: "retry", label: "Check again" }]);
  assert.equal(model.tone, "info");
  assert.equal(model.icon, "terminal");
  // Mobile never installs remotely: no install button exists, only the words.
  assert.ok(!model.actions.some((action) => /install/i.test(action.id)));
});

test("without a machine name the fix names your computer", () => {
  const model = problemModel(rpc(-32602, "run git"), { action: "commit your changes" });
  assert.equal(model.body, "Install it on your computer, then check again.");
  assert.equal(model.title, "Install Git to commit your changes");
});

test("a machine name loses its local suffix", () => {
  assert.equal(problemModel(rpc(-32602, "run gh"), { action: "load pull requests", machine: "Treshnandas-Macbook.local" }).body, "Install it on Treshnandas-Macbook, then check again.");
});

test("a signed-out gh is fixed on the computer", () => {
  const model = problemModel(rpc(-32602, "gh pr list: To get started with GitHub CLI, please run:  gh auth login"), { action: "load pull requests", machine: "SatyaMas" });
  assert.equal(model.kind, "signed_out");
  assert.equal(model.title, "Sign in to GitHub to load pull requests");
  assert.equal(model.body, "Sign in to GitHub on SatyaMas, then check again.");
  assert.deepEqual(model.actions.map((action) => action.id), ["retry"]);
  assert.equal(model.tone, "warning");
});

test("an older Kybern is updated on the computer", () => {
  const model = problemModel(rpc(-32601, "method not found: notes.history"), { action: "show note history", machine: "SatyaMas" });
  assert.equal(model.kind, "update_needed");
  assert.equal(model.title, "Update Kybern to show note history");
  assert.equal(model.body, "Update Kybern on SatyaMas, then try again.");
  assert.deepEqual(model.actions.map((action) => action.id), ["retry"]);
});

test("an offline machine is named and says it keeps trying", () => {
  const model = problemModel(rpc(-32013, "SatyaMas is offline."), { action: "read notes", note: "Your notes are saved." });
  assert.equal(model.kind, "offline");
  assert.equal(model.title, "SatyaMas is offline");
  assert.match(model.body, /Kybern keeps trying/);
  assert.match(model.body, /Your notes are saved\.$/);
  assert.deepEqual(model.actions.map((action) => action.id), ["retry", "open_machines"]);
  assert.equal(model.icon, "wifi.slash");
  assert.equal(model.tone, "neutral");
});

test("an offline error with no name still points at your computer", () => {
  for (const error of [new OfflineError("m-1", false), new Error("Network request failed")]) {
    const model = problemModel(error, { action: "open the thread" });
    assert.equal(model.kind, "offline");
    assert.equal(model.title, "Can't reach your computer");
  }
});

test("a machine the phone no longer trusts leads to Machines, not a retry", () => {
  const unpaired = problemModel({ code: "unpaired", message: "Pair again" }, { action: "connect", machine: "SatyaMas" });
  assert.equal(unpaired.title, "Pair SatyaMas again");
  assert.deepEqual(unpaired.actions.map((action) => action.id), ["open_machines"]);
  const identity = problemModel({ code: "identity_mismatch", message: "x" }, { action: "connect", machine: "SatyaMas" });
  assert.equal(identity.title, "This phone can't verify SatyaMas");
  assert.deepEqual(identity.actions.map((action) => action.id), ["open_machines"]);
});

test("a clock problem tells the person what to set", () => {
  const model = problemModel({ code: "clock", message: "clock skew 9000s" }, { action: "connect", machine: "SatyaMas" });
  assert.equal(model.title, "Check this phone's clock");
  assert.match(model.body, /automatic time/);
});

test("an unknown failure keeps the technical text only in the detail", () => {
  const model = problemModel(rpc(-32603, "threads.rename: save thread: database is locked"), { action: "rename the thread" });
  assert.equal(model.kind, "internal");
  assert.equal(model.title, "Couldn't rename the thread");
  assert.equal(model.detail, "threads.rename: save thread: database is locked");
  assert.doesNotMatch(model.title + model.body, /database|threads\.rename/);
  assert.equal(model.tone, "danger");
});

test("the daemon's data.problem outranks the text", () => {
  const model = problemModel(rpc(-32010, "Git isn't installed.", { problem: { kind: "tool_missing", subject: "git", detail: "run git: program not found", retryable: true } }), { action: "commit your changes", machine: "SatyaMas" });
  assert.equal(model.kind, "tool_missing");
  assert.equal(model.detail, "run git: program not found");
});

const CASES = [
  new Error("RpcCallError: something odd"),
  rpc(-32602, "invalid params: missing field `thread_id` at line 1 column 2"),
  rpc(-32003, "not found: terminal"),
  new Error("EPERM: operation not permitted, symlink 'C:\\Program Files\\x' -> 'C:\\Users\\Bagus\\y'"),
  rpc(-32602, "write C:\\work\\a.txt: Access is denied. (os error 5)"),
  "boom",
];

test("no headline, sentence or label carries jargon, and no title ends in a period", () => {
  for (const error of CASES) {
    const model = problemModel(error, { action: "save the file" });
    assert.doesNotMatch(model.title, JARGON, String(error));
    assert.doesNotMatch(model.body, JARGON, String(error));
    assert.doesNotMatch(problemText(model), JARGON, String(error));
    assert.doesNotMatch(model.title, /\.$/);
    assert.ok(model.actions.length <= 2);
    for (const action of model.actions) assert.match(action.label, /^[A-Z][a-z]+/, "a button starts with a verb or noun in sentence case");
  }
});

test("errorText's sentence drops advice that needs Show details", () => {
  const text = sentenceOf(new Error("boom"), "send your message");
  assert.equal(text, "Couldn't send your message. Try again.");
  assert.equal(sentenceOf(new Error("boom")), "Couldn't finish that. Try again.");
});

test("every kind has a tone and a glyph", () => {
  for (const kind of ["tool_missing", "signed_out", "permission", "offline", "conflict", "invalid_input", "not_found", "update_needed", "internal"]) {
    const look = problemLook(kind);
    assert.ok(["info", "warning", "danger", "neutral"].includes(look.tone), kind);
    assert.ok(look.icon.length > 0, kind);
  }
  assert.equal(problemLook("offline").icon, "wifi.slash");
});

test("a request that never got an answer is the computer being out of reach", () => {
  for (const message of ["Network request failed", "The operation was aborted due to timeout", "fetch failed", "App Transport Security policy requires secure connection"]) {
    const model = problemModel(new Error(message), { action: "load your notes" });
    assert.equal(model.kind, "offline", message);
    assert.equal(model.title, "Can't reach your computer");
    assert.equal(model.detail, message);
  }
});

test("a project with no GitHub remote asks for one on the computer", () => {
  const model = prProblemModel(rpc(-32602, "no GitHub remote for this project"), { action: "load pull requests", machine: "SatyaMas" });
  assert.equal(model.kind, "not_found");
  assert.equal(model.subject, "github_remote");
  assert.equal(model.title, "This project isn’t on GitHub");
  assert.equal(model.body, "Add a GitHub remote to this project on SatyaMas, then check again.");
});
