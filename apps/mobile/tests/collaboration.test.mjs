import test from "node:test";
import assert from "node:assert/strict";
import {
  collaborationEventGroupId,
  shouldReloadCollaboration,
} from "../../../packages/kybern-client/src/collaboration.ts";

const base = { seq: 4, thread_id: "thread-a", at: "2026-09-13T00:00:00Z" };

test("collaboration updates refresh only the affected group", () => {
  const event = {
    ...base,
    kind: "collaboration_assignment_updated",
    assignment: { group_id: "group-a" },
  };
  assert.equal(collaborationEventGroupId(event), "group-a");
  assert.equal(shouldReloadCollaboration(event, "group-a"), true);
  assert.equal(shouldReloadCollaboration(event, "group-b"), false);
});

test("reconnect barriers refresh the authoritative collaboration snapshot", () => {
  assert.equal(shouldReloadCollaboration(null, "group-a"), true);
  assert.equal(
    shouldReloadCollaboration({ ...base, kind: "assistant_text_delta", message_id: "message", origin: { kind: "root" }, delta: "x" }, "group-a"),
    false,
  );
});
