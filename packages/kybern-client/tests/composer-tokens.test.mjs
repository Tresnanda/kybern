import assert from "node:assert/strict";
import test from "node:test";
import { buildStructuredTextParts, nextAttachmentLabel } from "../src/composerTokens.ts";

const attachment = (id) => ({ type: "attachment", asset_id: id, name: `${id}.png`, media_type: "image/png", size: 1 });

test("a mentioned attachment rides right after its first inline label", () => {
  const references = [
    { token: "@image1", part: attachment("a") },
    { token: "@image2", part: attachment("b") },
  ];
  const parts = buildStructuredTextParts("use @image1 as bg, @image2 as logo; keep @image1 soft. not @image10", new Set(), [], [], references);
  assert.deepEqual(parts, [
    { type: "text", text: "use @image1" },
    attachment("a"),
    { type: "text", text: " as bg, @image2" },
    attachment("b"),
    { type: "text", text: " as logo; keep @image1 soft. not @image10" },
  ]);
});

test("attachment labels fill the first free number per kind", () => {
  assert.equal(nextAttachmentLabel("image/png", ["image1", "image3"]), "image2");
  assert.equal(nextAttachmentLabel("application/pdf", ["image1"]), "file1");
});

import { createComposerMentionReference, structuredSegments } from "../src/composerTokens.ts";
import { noteMentionPart, parseKybernMention, taskMentionPart } from "../src/userInput.ts";

test("note and task chips round-trip as mention parts", () => {
  const note = createComposerMentionReference(noteMentionPart({ id: "n1", title: "Login  plan" }), []);
  const task = createComposerMentionReference(taskMentionPart({ id: "t1", key: "ADE-14", title: "Fix login" }), [note]);
  assert.equal(note.token, '@"Login plan"');
  assert.equal(task.token, '@"ADE-14 Fix login"');
  const text = `see ${note.token} and ${task.token}, then ship`;
  assert.deepEqual(buildStructuredTextParts(text, new Set(), [], [], [], [note, task]), [
    { type: "text", text: "see " },
    { type: "mention", name: "Login plan", path: "kybern://note/n1", display_name: "Login plan" },
    { type: "text", text: " and " },
    { type: "mention", name: "Fix login", path: "kybern://task/t1", display_name: "ADE-14 Fix login" },
    { type: "text", text: ", then ship" },
  ]);
  assert.deepEqual(structuredSegments(text, new Set(), [], [], [], [note, task]).map((segment) => segment.kind), ["text", "token", "text", "token", "text"]);
  assert.deepEqual(parseKybernMention("kybern://task/t1"), { kind: "task", id: "t1" });
  assert.equal(parseKybernMention("plugin://x"), null);
});

test("a mention never reuses a token another pick already shows", () => {
  const thread = { token: '@"Release"', part: { type: "thread_reference", thread_id: "th1", title: "Release" } };
  const first = createComposerMentionReference(noteMentionPart({ id: "n1", title: "Release" }), [], [thread.token]);
  assert.equal(first.token, '@"Release (2)"');
  assert.equal(createComposerMentionReference(noteMentionPart({ id: "n1", title: "Renamed" }), [first]), first);
  const parts = buildStructuredTextParts(`${thread.token} ${first.token}`, new Set(), [], [thread], [], [first]);
  assert.deepEqual(parts.map((part) => part.type), ["thread_reference", "text", "mention"]);
});
