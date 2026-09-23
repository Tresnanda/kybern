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
