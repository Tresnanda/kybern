import test from "node:test";
import assert from "node:assert/strict";
import { createComposerThreadReference, threadReferencePart } from "../src/threadReferences.ts";
import { buildStructuredTextParts, partToken, structuredSegments } from "../src/composerTokens.ts";

const firstThread = { id: "thread-one", project_id: "project-one", title: "Authentication decisions" };
const provider = {
  kind: "claude-code", available: true, instances: ["default", "team"],
  supported_permission_modes: ["supervised", "full-access"], models: [{ id: "model", efforts: ["medium"] }],
};
const input = { projectId: "project-one", provider, model: "model", effort: "medium" };

test("thread picker identity survives matching titles and a title refresh", () => {
  const first = createComposerThreadReference(firstThread, []);
  const second = createComposerThreadReference({ ...firstThread, id: "thread-two" }, [first], "Kybern");
  const third = createComposerThreadReference({ ...firstThread, id: "thread-three" }, [first, second], "Kybern");
  assert.equal(new Set([first.token, second.token, third.token]).size, 3);
  assert.equal(createComposerThreadReference({ ...firstThread, title: "Renamed" }, [first]), first);
  const text = `Compare ${first.token} with ${second.token} and ${third.token}.`;
  const parts = buildStructuredTextParts(text, new Set(), [], [first, second, third]);
  assert.deepEqual(parts.filter((part) => part.type === "thread_reference").map((part) => part.thread_id), ["thread-one", "thread-two", "thread-three"]);
  assert.equal(structuredSegments(text, new Set(), [], [first, second, third]).map((part) => part.text).join(""), text);
  assert.equal(text.includes(firstThread.id), false);
});

test("unselected or ambiguous thread text remains plain text", () => {
  const first = createComposerThreadReference(firstThread, []);
  assert.deepEqual(buildStructuredTextParts(first.token, new Set(), []), [{ type: "text", text: first.token }]);
  const conflicting = { token: first.token, part: { ...first.part, thread_id: "other" } };
  assert.deepEqual(buildStructuredTextParts(first.token, new Set(), [], [first, conflicting]), [{ type: "text", text: first.token }]);
  assert.deepEqual(buildStructuredTextParts(`${first.token}suffix`, new Set(), [], [first]), [{ type: "text", text: `${first.token}suffix` }]);
});

test("quoted titles keep surrounding instructions and other attachments intact", () => {
  const reference = createComposerThreadReference({ ...firstThread, title: 'Fix "UI" [draft]\nnotes' }, []);
  const text = `Read ${reference.token}, then inspect @README.md.`;
  const parts = buildStructuredTextParts(text, new Set(["README.md"]), [], [reference]);
  assert.deepEqual(parts.map((part) => part.type), ["text", "thread_reference", "text", "file_mention", "text"]);
  assert.equal(parts[1].title, 'Fix "UI" [draft] notes');
  assert.equal(partToken(threadReferencePart(firstThread)), '@"Authentication decisions"');
});
