import test from "node:test";
import assert from "node:assert/strict";
import { projectSpaceNotes, notePreviewLine } from "../src/projectSpace.ts";
import { isSecretRequest, secretDestination, secretOutcome, secretOutcomeLine, secretPartsText, secretRequestInput } from "../src/secretRequest.ts";

const note = (id, extra = {}) => ({
  id, scope: "project", project_id: "p1", title: id, preview: "", checklist: { done: 0, total: 0 }, pinned: false,
  revision: 1, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z", ...extra,
});

test("project space splits brief, setup and memory, newest memory first", () => {
  const space = projectSpaceNotes([
    note("brief", { project_role: "brief", pinned: true }),
    note("setup", { project_role: "setup", pinned: true }),
    note("old", { updated_at: "2026-10-01T00:00:00Z" }),
    note("new", { updated_at: "2026-10-03T00:00:00Z" }),
    note("deleted", { deleted_at: "2026-10-04T00:00:00Z" }),
    note("other-project", { project_id: "p2" }),
    note("thread-note", { scope: "thread", thread_id: "t1" }),
    note("global", { scope: "global", project_id: null }),
  ], "p1");
  assert.equal(space.brief?.id, "brief");
  assert.equal(space.setup?.id, "setup");
  assert.deepEqual(space.memory.map((item) => item.id), ["new", "old"]);
});

test("project space without role notes has no brief or setup", () => {
  const space = projectSpaceNotes([note("memory")], "p1");
  assert.equal(space.brief, null);
  assert.equal(space.setup, null);
  assert.equal(space.memory.length, 1);
  assert.equal(notePreviewLine({ preview: "  one\n\n two  " }), "one two");
});

const approval = (input) => ({ tool_name: "kybern_request_secret", input });

test("secret request input is read only from the secret tool", () => {
  assert.equal(secretRequestInput({ tool_name: "Bash", input: { env_key: "X" } }), null);
  assert.equal(secretRequestInput(approval({ label: "No key" })), null);
  assert.equal(isSecretRequest(approval({})), true);
  const input = secretRequestInput(approval({ label: "Stripe key", reason: "Tests", env_key: "STRIPE_KEY", file: ".env", replaces: false }));
  assert.deepEqual(input, { label: "Stripe key", reason: "Tests", env_key: "STRIPE_KEY", file: ".env", replaces: false, placeholder: null });
});

test("destination says where the value goes", () => {
  assert.equal(secretPartsText(secretDestination({ env_key: "K", file: ".env", replaces: false })), "Saves to .env as K");
  assert.equal(secretPartsText(secretDestination({ env_key: "K", file: "api/.env.local", replaces: true })), "Replaces the current value of K in api/.env.local");
  assert.deepEqual(secretDestination({ env_key: "K", file: ".env", replaces: false }).filter((part) => part.code).map((part) => part.text), [".env", "K"]);
});

test("settled line follows the recorded decision and never the value", () => {
  const input = { env_key: "K", file: ".env" };
  assert.equal(secretOutcome(null), "pending");
  assert.equal(secretPartsText(secretOutcomeLine(input, { decision: "submit", response: { secret: "[redacted]" } })), "Saved to .env as K");
  assert.equal(secretPartsText(secretOutcomeLine(input, { decision: "deny" })), "Declined K");
  assert.equal(secretPartsText(secretOutcomeLine(input, { decision: "deny", reason: "turn ended" })), "Request ended: the agent stopped before you answered");
  assert.equal(secretPartsText(secretOutcomeLine(input, { decision: "deny", reason: "timed out" })), "Request ended: no answer in time");
  assert.equal(secretPartsText(secretOutcomeLine(input, null, false)), "Request ended: the agent stopped before you answered");
  assert.equal(secretPartsText(secretOutcomeLine(input, null)), "Waiting for you to provide K");
});
