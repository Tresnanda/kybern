import assert from "node:assert/strict";
import test from "node:test";
import {
  changeTrait,
  findModel,
  isFavorite,
  isFavoriteModel,
  modelQualifier,
  modelSections,
  parameterSwitch,
  rememberModel,
  searchModels,
  selectorEffort,
  traitUnavailableReason,
  selectedVariant,
  toggleFavorite,
  toggleFavoriteModel,
  traitSummary,
  traitValues,
  variantSelector,
} from "../src/models.ts";

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

const selector = (selection) => `cursor-model:${Buffer.from(JSON.stringify(selection)).toString("base64url")}`;
const variantId = (context, fast, effortValues = ["low", "high"]) =>
  selector({ id: "opus", params: [{ id: "context", value: context }, { id: "fast", value: fast }], effortParam: "effort", effortValues, defaultEffort: "low" });
const opus = {
  id: variantId("300000", "false"),
  display_name: "Claude Opus 5.5",
  resolved_id: "opus",
  efforts: ["low", "high"],
  default_effort: "low",
  parameters: [
    { id: "context", label: "Context", default: "300000", values: [{ value: "300000", label: "300K" }, { value: "1000000", label: "1M" }] },
    { id: "fast", label: "Fast", default: "false", values: [{ value: "false", label: "Off" }, { value: "true", label: "On" }] },
  ],
  variants: [
    { id: variantId("300000", "false"), params: { context: "300000", fast: "false" } },
    { id: variantId("300000", "true"), params: { context: "300000", fast: "true" } },
    { id: variantId("1000000", "false"), params: { context: "1000000", fast: "false" } },
    { id: variantId("1000000", "true"), params: { context: "1000000", fast: "true" } },
  ],
};
const cursorCatalog = [{ id: "default", display_name: "Default", is_default: true }, opus];

test("every variant id resolves to its one model row", () => {
  for (const variant of opus.variants) assert.equal(findModel(cursorCatalog, variant.id), opus);
  assert.equal(findModel(cursorCatalog, "opus"), opus);
});

test("an old variant id still resolves, with its traits, after the catalog changed its efforts", () => {
  const old = variantId("1000000", "true", ["low", "medium", "high"]);
  assert.notEqual(old, opus.variants[3].id);
  assert.equal(findModel(cursorCatalog, old), opus);
  assert.equal(selectedVariant(opus, old), opus.variants[3]);
  assert.deepEqual(traitValues(opus, old), { context: "1000000", fast: "true" });
  assert.equal(variantSelector(opus, old), opus.variants[3].id);
});

test("traits default from the row when no variant is named", () => {
  assert.deepEqual(traitValues(opus, "opus"), { context: "300000", fast: "false" });
  assert.equal(variantSelector(opus, null), opus.id);
  assert.deepEqual(traitValues({ id: "plain" }, "plain"), {});
});

test("changing one trait keeps the others, or the closest combination when it is missing", () => {
  const start = opus.variants[2].id;
  assert.equal(changeTrait(opus, start, "fast", "true"), opus.variants[3]);
  assert.equal(changeTrait(opus, start, "context", "300000"), opus.variants[0]);
  const sparse = { ...opus, variants: [opus.variants[0], opus.variants[3]] };
  assert.equal(changeTrait(sparse, opus.variants[0].id, "fast", "true"), opus.variants[3]);
  assert.equal(changeTrait(sparse, opus.variants[0].id, "fast", "maybe"), undefined);
});

test("the trigger shows only traits that differ from the default", () => {
  assert.equal(traitSummary(opus, opus.id), null);
  assert.equal(traitSummary(opus, opus.variants[2].id), "1M");
  assert.equal(traitSummary(opus, opus.variants[3].id), "1M · Fast");
  assert.equal(traitSummary(opus, opus.variants[1].id), "Fast");
  assert.equal(traitSummary({ id: "x" }, "x"), null);
  const defaultsOn = { ...opus, parameters: [{ ...opus.parameters[1], default: "true" }], variants: [{ id: "a", params: { fast: "false" } }] };
  assert.equal(traitSummary(defaultsOn, "a"), "Fast off");
});

test("boolean parameters render as switches, others do not", () => {
  assert.deepEqual(parameterSwitch(opus.parameters[1]), { on: "true", off: "false" });
  assert.deepEqual(parameterSwitch({ values: [{ value: "off" }, { value: "on" }] }), { on: "on", off: "off" });
  assert.equal(parameterSwitch(opus.parameters[0]), null);
  assert.equal(parameterSwitch({ values: [{ value: "a" }, { value: "b" }] }), null);
});

test("favorites store the model row and still honor variant favorites saved earlier", () => {
  const legacy = [{ kind: "cursor", id: opus.variants[3].id }, { kind: "cursor", id: opus.variants[1].id }, { kind: "claude", id: "opus" }];
  assert.equal(isFavoriteModel(legacy, "cursor", opus), true);
  assert.equal(isFavoriteModel(legacy, "cursor", cursorCatalog[0]), false);
  // A Claude favorite for the same string is a different harness, and a plain model needs an exact id.
  assert.equal(isFavoriteModel([{ kind: "claude", id: "claude-opus-5-5" }], "claude", { id: "opus", resolved_id: "claude-opus-5-5" }), false);
  assert.deepEqual(toggleFavoriteModel(legacy, "cursor", opus), [{ kind: "claude", id: "opus" }]);
  assert.deepEqual(toggleFavoriteModel([], "cursor", opus), [{ kind: "cursor", id: opus.id }]);
});

const gptSelector = (params, effortValues) => selector({ id: "gpt-5.5", params, ...(effortValues ? { effortParam: "reasoning", effortValues, defaultEffort: "medium" } : {}) });
const gptVariant = (context, fast) => ({
  id: gptSelector([{ id: "context", value: context }, { id: "fast", value: fast }], ["low", "medium", "high"]),
  params: { context, fast }, efforts: ["low", "medium", "high"], default_effort: "medium",
});
// GPT-5.5 has no 1M context with Fast.
const gpt = {
  id: gptVariant("300000", "false").id, display_name: "GPT-5.5", resolved_id: "gpt-5.5",
  efforts: ["low", "medium", "high"], default_effort: "medium",
  parameters: opus.parameters,
  variants: [gptVariant("300000", "false"), gptVariant("300000", "true"), gptVariant("1000000", "false")],
};

test("an old GPT selector with a reasoning parameter resolves to its row and its effort", () => {
  const old = gptSelector([{ id: "reasoning", value: "high" }, { id: "context", value: "1000000" }, { id: "fast", value: "false" }]);
  assert.equal(findModel([gpt], old), gpt);
  assert.equal(selectedVariant(gpt, old), gpt.variants[2]);
  assert.equal(selectorEffort(gpt, old), "high");
  assert.equal(selectorEffort(gpt, gpt.variants[2].id), undefined);
  assert.equal(selectorEffort(gpt, gptSelector([{ id: "reasoning", value: "none" }])), undefined);
  assert.equal(selectorEffort(gpt, "gpt-5.5"), undefined);
});

test("options a catalog does not offer with the current traits say why they are unavailable", () => {
  const big = gpt.variants[2].id;
  assert.equal(traitUnavailableReason(gpt, big, "fast", "true"), "Fast isn't available with 1M context");
  assert.equal(traitUnavailableReason(gpt, big, "fast", "false"), null);
  assert.equal(traitUnavailableReason(gpt, big, "context", "300000"), null);
  const fast = gpt.variants[1].id;
  assert.equal(traitUnavailableReason(gpt, fast, "context", "1000000"), "1M context isn't available with Fast");
  assert.equal(traitUnavailableReason(gpt, gpt.variants[0].id, "context", "1000000"), null);
  assert.equal(traitUnavailableReason(opus, opus.variants[2].id, "fast", "true"), null);
  assert.equal(traitUnavailableReason({ id: "plain" }, "plain", "fast", "true"), null);
});
