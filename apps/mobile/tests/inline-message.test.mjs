import assert from "node:assert/strict";
import test from "node:test";
import {
  inlineTextRuns,
  groupInlineParts,
  inlineTokenSources,
} from "../src/state/inlineMessage.ts";
import { insertComposerPart } from "../src/state/capabilities.ts";
import {
  buildStructuredTextParts,
  structuredSegments,
} from "../../../packages/kybern-client/src/composerTokens.ts";
const skill = {
  type: "skill",
  name: "better-ui",
  path: "/skills/better-ui/SKILL.md",
};
const plugin = {
  type: "mention",
  name: "figma",
  display_name: "Figma Design",
  path: "/plugins/figma",
};
const file = { type: "file_mention", path: "src/My App.tsx" };
test("structured parts flow in one paragraph, retaining prose, spacing and markers", () => {
  const parts = [
    { type: "text", text: "Please use " },
    skill,
    { type: "text", text: " and " },
    plugin,
    { type: "text", text: ".\nKeep this paragraph." },
  ];
  const groups = groupInlineParts(
    parts.map((part, index) => ({ part, index })),
  );
  assert.equal(groups.length, 1);
  const runs = inlineTextRuns(parts);
  assert.equal(
    runs.map((r) => r.text).join(""),
    "Please use $better-ui and @Figma Design.\nKeep this paragraph.",
  );
  assert.deepEqual(
    runs.filter((r) => r.highlighted).map((r) => r.text),
    ["$better-ui", "@Figma Design"],
  );
  assert.equal(
    inlineTextRuns([skill, plugin, { type: "text", text: "continue" }])
      .map((r) => r.text)
      .join(""),
    "$better-ui @Figma Design continue",
  );
  const attachment = {
    type: "attachment",
    asset_id: "a",
    name: "log.txt",
    media_type: "text/plain",
    size: 1,
  };
  assert.deepEqual(
    groupInlineParts(
      [...parts, attachment, file].map((part, index) => ({ part, index })),
    ).map((g) => g.inline),
    [true, false, true],
  );
});
test("picker insertion replaces only the caret token and keeps its wire identity", () => {
  const text = "Please use $bet then keep the suffix";
  const caret = text.indexOf(" then");
  const next = insertComposerPart(text, { start: caret, end: caret }, skill);
  assert.equal(next.text, "Please use $better-ui then keep the suffix");
  assert.equal(next.caret, "Please use $better-ui ".length);
  const sources = inlineTokenSources([skill, plugin, file]);
  const value = "$better-ui, @Figma Design and @src/My App.tsx please";
  const parts = buildStructuredTextParts(
    value,
    sources.mentions,
    sources.skills,
  );
  assert.deepEqual(
    parts.filter((p) => p.type !== "text"),
    [skill, plugin, file],
  );
  assert.equal(
    structuredSegments(value, sources.mentions, sources.skills)
      .map((s) => s.text)
      .join(""),
    value,
  );
  assert.deepEqual(
    buildStructuredTextParts(
      "$unknown and email@example.com",
      sources.mentions,
      sources.skills,
    ),
    [{ type: "text", text: "$unknown and email@example.com" }],
  );
  assert.equal(
    insertComposerPart("before after", { start: 7, end: 12 }, plugin, false)
      .text,
    "before @Figma Design ",
  );
});
