import assert from "node:assert/strict";
import test from "node:test";
import { findModel, isFavorite, modelQualifier, modelSections, rememberModel, searchModels, toggleFavorite } from "../src/models.ts";

const catalog = [
  { id: "opus[1m]", display_name: "Claude Opus 5.5 · 1M", resolved_id: "claude-opus-5-5[1m]" },
  { id: "claude-fable-5-1[1m]", display_name: "Claude Fable 5.1 · 1M", resolved_id: "claude-fable-5-1" },
  { id: "claude-opus-4-8", display_name: "Claude Opus 4.8", resolved_id: "claude-opus-4-8" },
];

test("a thread's model matches its selector or the model the selector runs", () => {
  assert.equal(findModel(catalog, "opus[1m]")?.id, "opus[1m]");
  assert.equal(findModel(catalog, "claude-fable-5-1")?.id, "claude-fable-5-1[1m]");
  assert.equal(findModel(catalog, "claude-opus-4-8")?.id, "claude-opus-4-8");
});

test("a session's concrete id matches across a context suffix", () => {
  assert.equal(findModel(catalog, "claude-opus-5-5")?.id, "opus[1m]");
  assert.equal(findModel(catalog, "claude-fable-5-1[1m]")?.id, "claude-fable-5-1[1m]");
  assert.equal(findModel(catalog, "claude-sonnet-5"), undefined);
  assert.equal(findModel(catalog, ""), undefined);
});

const m = (id, display_name, provider = null, extra = {}) => ({ id, display_name, provider, ...extra });

test("several backends group by backend, the default's backend first", () => {
  const catalog = [
    m("apple/on-device", "Apple AFM 3 Core", "apple"),
    m("cursor/default", "Auto", "cursor", { is_default: true }),
    m("cursor/grok-4.7", "Grok 4.7", "cursor"),
    m("openrouter/x-ai/grok-4.7", "Grok 4.7", "openrouter"),
  ];
  const sections = modelSections(catalog);
  assert.deepEqual(sections.map((s) => s.label), ["Cursor", "Apple", "OpenRouter"]);
  assert.deepEqual(sections[0].models.map((x) => x.id), ["cursor/default", "cursor/grok-4.7"]);
});

test("a repeated name is qualified by its backend, a unique one is not", () => {
  const catalog = [m("cursor/grok-4.7", "Grok 4.7", "cursor"), m("openrouter/x-ai/grok-4.7", "Grok 4.7", "openrouter"), m("cursor/auto", "Auto", "cursor")];
  assert.equal(modelQualifier(catalog, catalog[1]), "OpenRouter");
  assert.equal(modelQualifier(catalog, catalog[0]), "Cursor");
  assert.equal(modelQualifier(catalog, catalog[2]), null);
});

test("a small single-backend catalog stays flat", () => {
  const catalog = [m("opus", "Claude Opus 5.5"), m("sonnet", "Claude Sonnet 5.5")];
  assert.deepEqual(modelSections(catalog).map((s) => s.label), [null]);
});

test("a large catalog without backends groups by family with singles under Other", () => {
  const names = ["Auto", "Claude Opus 5.5", "Claude Sonnet 5", "GPT-5.6 Sol", "GPT-5.4", "Grok 4.7", "Grok 4.6",
    "Gemini 3.7 Flash", "Gemini 3 Pro", "Kimi K3", "Kimi K2", "Codex 5.3", "Codex 5.3 Fast", "condor"];
  const sections = modelSections(names.map((n, i) => m(String(i), n)));
  assert.deepEqual(sections.map((s) => s.label), ["Claude", "GPT", "Grok", "Gemini", "Kimi", "Codex", "Other"]);
  assert.deepEqual(sections.at(-1).models.map((x) => x.display_name), ["Auto", "condor"]);
});

test("search matches every word across name, id and backend", () => {
  const catalog = [m("openrouter/x-ai/grok-4.7", "Grok 4.7", "openrouter"), m("cursor/grok-4.7", "Grok 4.7", "cursor"), m("cursor/claude-fable-5", "Claude Fable 5", "cursor")];
  assert.deepEqual(searchModels(catalog, "grok cursor").map((x) => x.id), ["cursor/grok-4.7"]);
  assert.deepEqual(searchModels(catalog, "x-ai").map((x) => x.id), ["openrouter/x-ai/grok-4.7"]);
  assert.deepEqual(searchModels(catalog, "fable").map((x) => x.id), ["cursor/claude-fable-5"]);
});

test("recent models stay unique and capped", () => {
  assert.deepEqual(rememberModel(["a", "b", "c"], "b", 3), ["b", "a", "c"]);
  assert.deepEqual(rememberModel(["a", "b", "c"], "d", 3), ["d", "a", "b"]);
});

test("favorites are keyed by harness and model, and toggle in place", () => {
  let favorites = toggleFavorite([], "omp", "cursor/grok-4.7");
  favorites = toggleFavorite(favorites, "claude-code", "opus");
  assert.ok(isFavorite(favorites, "omp", "cursor/grok-4.7"));
  assert.ok(!isFavorite(favorites, "pi", "cursor/grok-4.7"));
  favorites = toggleFavorite(favorites, "omp", "cursor/grok-4.7");
  assert.deepEqual(favorites, [{ kind: "claude-code", id: "opus" }]);
});


test("legacy Cursor effort selectors resolve to the grouped model without losing context", () => {
  const selector = (params) => `cursor-model:${Buffer.from(JSON.stringify({id:"gpt",params})).toString("base64url")}`;
  const regular = selector([]);
  const large = selector([{id:"context",value:"1000000"}]);
  const rows = [{id:regular},{id:large}];
  assert.equal(findModel(rows, selector([{id:"reason_effort",value:"high"}]))?.id, regular);
  assert.equal(findModel(rows, selector([{id:"reason_effort",value:"low"},{id:"context",value:"1000000"}]))?.id, large);
  assert.equal(findModel(rows, "cursor-model:broken"), undefined);
});

test("named accounts have isolated favorites while legacy favorites stay default", () => {
  const legacy = [{ kind: "codex", id: "shared-model" }];
  assert.equal(isFavorite(legacy, "codex", "shared-model", "default"), true);
  assert.equal(isFavorite(legacy, "codex", "shared-model", "work"), false);
  const both = toggleFavorite(legacy, "codex", "shared-model", "work");
  assert.equal(isFavorite(both, "codex", "shared-model", "work"), true);
  assert.equal(isFavorite(both, "codex", "shared-model", "default"), true);
  assert.deepEqual(toggleFavorite(both, "codex", "shared-model", "work"), legacy);
});
