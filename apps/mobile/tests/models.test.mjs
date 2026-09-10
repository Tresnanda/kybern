import assert from "node:assert/strict";
import test from "node:test";
import {
  customModelId,
  modelChoices,
} from "../../../packages/kybern-client/src/models.ts";

const catalog = [
  { id: "opus", display_name: "Claude Opus", default_effort: "high" },
];

test("model catalogs allow exact custom slugs and retain a selected model absent from discovery", () => {
  assert.equal(
    modelChoices(catalog, "opus", "  claude-opus-4-8  ").customId,
    "claude-opus-4-8",
  );
  const selected = modelChoices(catalog, "claude-opus-4-8");
  assert.deepEqual(
    selected.models.map((model) => model.id),
    ["", "claude-opus-4-8", "opus"],
  );
  assert.equal(selected.models[1].custom, true);
  assert.equal(
    modelChoices(catalog, "claude-opus-4-8", "claude-opus-4-8").customId,
    null,
  );
  assert.equal(modelChoices(catalog, "opus", "opus").customId, null);
  assert.equal(
    modelChoices([], null, "provider/model:version[1m]").customId,
    "provider/model:version[1m]",
  );
  assert.equal(
    modelChoices(catalog, "opus", "Claude Opus").models[0].id,
    "opus",
  );
  assert.equal(modelChoices(catalog, "opus", "Claude Opus").customId, null);
  assert.equal(
    modelChoices(catalog, "opus", "OPUS").customId,
    "OPUS",
    "opaque IDs retain case",
  );
});

test("custom model input trims outer whitespace without rewriting IDs or accepting empty/multiline input", () => {
  assert.equal(
    customModelId("  gateway/Custom.Model-v2:2026  "),
    "gateway/Custom.Model-v2:2026",
  );
  for (const input of [
    "",
    "   ",
    "model name",
    "model\nother",
    "model\tother",
    "model\0other",
  ]) {
    assert.equal(customModelId(input), null);
  }
});
