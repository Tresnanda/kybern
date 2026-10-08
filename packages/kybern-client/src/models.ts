import type { ModelParameter, ModelVariant, ProviderModel } from "./types.ts";

export type ModelChoice = Pick<
  ProviderModel,
  "id" | "display_name" | "default_effort" | "description" | "provider"
> & {
  custom?: true;
};

/** Model IDs are opaque to Kybern. Preserve provider prefixes, versions and aliases. */
export function customModelId(value: string): string | null {
  const id = value.trim();
  return id && !/[\s\p{Cc}]/u.test(id) ? id : null;
}

/**
 * The catalog entry for a thread's model. A running session reports the
 * concrete id (`claude-opus-5-5`), so an alias entry (`opus`) claims it too,
 * with or without a context suffix such as `[1m]` on either side.
 */
export function findModel<T extends Pick<ProviderModel, "id" | "resolved_id" | "variants">>(
  catalog: readonly T[],
  id: string | null | undefined,
): T | undefined {
  if (!id) return undefined;
  const base = withoutContext(id);
  return (
    catalog.find((model) => model.id === id) ??
    // A model with traits is one row; a thread may hold any of its variants.
    catalog.find((model) => model.variants?.some((variant) => variant.id === id)) ??
    catalog.find((model) => model.resolved_id === id) ??
    catalog.find((model) => model.variants?.some((variant) => sameCursorModel(variant.id, id))) ??
    catalog.find((model) => sameCursorModel(model.id, id)) ??
    catalog.find((model) => !!model.resolved_id && withoutContext(model.resolved_id) === base)
  );
}

/** Parameters Cursor models use for effort. Keep in step with `EFFORT_PARAMS` in the Cursor SDK host. */
const CURSOR_EFFORT_PARAMS = ["effort", "reason_effort", "reasoning_effort", "reasoningEffort", "reasoning"];

interface CursorSelection {
  id: string;
  params: { id: string; value: string }[];
}

function decodeCursorSelector(selector: string): CursorSelection | undefined {
  if (!selector.startsWith("cursor-model:")) return undefined;
  try {
    const encoded = selector.slice(13).replaceAll("-", "+").replaceAll("_", "/");
    const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    const selection = JSON.parse(new TextDecoder().decode(bytes)) as CursorSelection;
    return typeof selection.id === "string" && Array.isArray(selection.params) ? selection : undefined;
  } catch { return undefined; }
}

/** Older Cursor threads stored each effort as an opaque variant selector. */
function cursorModelKey(selector: string): string | undefined {
  const selection = decodeCursorSelector(selector);
  if (!selection) return undefined;
  const params = selection.params.filter((param) => !CURSOR_EFFORT_PARAMS.includes(param.id));
  return JSON.stringify([selection.id, params.sort((a, b) => a.id.localeCompare(b.id))]);
}

/**
 * The effort an older Cursor selector carried as a plain parameter (GPT's
 * `reasoning`), or undefined when it names none the row offers. Effort used to
 * live in the selector; now it is a separate control.
 */
export function selectorEffort(
  model: Pick<ProviderModel, "id" | "variants" | "efforts"> | undefined,
  selected: string | null | undefined,
): string | undefined {
  const selection = selected ? decodeCursorSelector(selected) : undefined;
  const value = selection?.params.find((param) => CURSOR_EFFORT_PARAMS.includes(param.id))?.value;
  if (value === undefined) return undefined;
  const offered = selectedVariant(model, selected)?.efforts?.length ? selectedVariant(model, selected)!.efforts! : model?.efforts ?? [];
  return offered.includes(value) ? value : undefined;
}

function sameCursorModel(left: string, right: string): boolean {
  const key = cursorModelKey(left);
  return key !== undefined && key === cursorModelKey(right);
}

/** The combination of traits a model id selects, or the row's default when it names none. */
export function selectedVariant(
  model: Pick<ProviderModel, "id" | "variants"> | undefined,
  selected: string | null | undefined,
): ModelVariant | undefined {
  const variants = model?.variants;
  if (!variants?.length) return undefined;
  return (
    (selected ? variants.find((variant) => variant.id === selected) ?? variants.find((variant) => sameCursorModel(variant.id, selected)) : undefined) ??
    variants.find((variant) => variant.id === model!.id) ??
    variants[0]
  );
}

/** Current value of every trait. */
export function traitValues(
  model: Pick<ProviderModel, "id" | "variants" | "parameters"> | undefined,
  selected: string | null | undefined,
): Record<string, string> {
  const variant = selectedVariant(model, selected);
  const out: Record<string, string> = {};
  for (const parameter of model?.parameters ?? []) out[parameter.id] = variant?.params[parameter.id] ?? parameter.default;
  return out;
}

/** The model selector to send for the traits a thread already holds. Effort changes use this so they keep context and fast mode. */
export function variantSelector(
  model: Pick<ProviderModel, "id" | "variants"> | undefined,
  selected: string | null | undefined,
): string | undefined {
  return selectedVariant(model, selected)?.id ?? model?.id;
}

/**
 * The variant after changing one trait. A catalog need not offer every
 * combination, so when the exact one is missing the closest keeps as many of
 * the other traits as it can.
 */
export function changeTrait(
  model: Pick<ProviderModel, "id" | "variants" | "parameters">,
  selected: string | null | undefined,
  parameter: string,
  value: string,
): ModelVariant | undefined {
  const current = traitValues(model, selected);
  let best: ModelVariant | undefined;
  let bestScore = -1;
  for (const variant of model.variants ?? []) {
    if (variant.params[parameter] !== value) continue;
    const score = Object.entries(current).filter(([id, other]) => id !== parameter && variant.params[id] === other).length;
    if (score > bestScore) {
      best = variant;
      bestScore = score;
    }
  }
  return best;
}

/** How a trait value reads inside a sentence: `Fast`, `Fast off`, `1M context`. */
function traitPhrase(parameter: ModelParameter, value: string): string {
  const toggle = parameterSwitch(parameter);
  if (toggle) return value === toggle.on ? parameter.label : `${parameter.label} off`;
  const label = parameter.values.find((item) => item.value === value)?.label ?? value;
  return `${label} ${parameter.label.toLowerCase()}`;
}

/**
 * Why a trait value cannot be chosen with the other traits as they are, or
 * null when it can. A catalog need not offer every combination (GPT-5.5 has
 * no 1M with Fast), so the picker disables such options instead of changing
 * another trait behind the user's back.
 */
export function traitUnavailableReason(
  model: Pick<ProviderModel, "id" | "variants" | "parameters">,
  selected: string | null | undefined,
  parameter: string,
  value: string,
): string | null {
  const variants = model.variants ?? [];
  if (!variants.length) return null;
  const current = traitValues(model, selected);
  const others = Object.entries(current).filter(([id]) => id !== parameter);
  if (variants.some((variant) => variant.params[parameter] === value && others.every(([id, other]) => variant.params[id] === other))) return null;
  const target = model.parameters?.find((item) => item.id === parameter);
  if (!target) return null;
  const withValue = variants.filter((variant) => variant.params[parameter] === value);
  // Name the traits that, on their own, rule the value out; fall back to all of them.
  let blockers = others.filter(([id, other]) => !withValue.some((variant) => variant.params[id] === other));
  if (!blockers.length) blockers = others;
  const phrases = blockers.flatMap(([id, other]) => {
    const item = model.parameters?.find((entry) => entry.id === id);
    return item ? [traitPhrase(item, other)] : [];
  });
  const subject = traitPhrase(target, value);
  const text = `${subject} isn't available${phrases.length ? ` with ${phrases.join(" and ")}` : ""}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A parameter that is a plain on/off choice reads as a switch. */
export function parameterSwitch(parameter: Pick<ModelParameter, "values">): { on: string; off: string } | null {
  const values = parameter.values.map((item) => item.value);
  if (values.length !== 2) return null;
  for (const [on, off] of [["true", "false"], ["on", "off"]] as const) {
    if (values.includes(on) && values.includes(off)) return { on, off };
  }
  return null;
}

/**
 * Traits that differ from the model's defaults, for the composer trigger:
 * `1M · Fast` after the model name. A switch shows its label when on and
 * `<label> off` when its default is on.
 */
export function traitSummary(
  model: Pick<ProviderModel, "id" | "variants" | "parameters"> | undefined,
  selected: string | null | undefined,
): string | null {
  if (!model?.parameters?.length) return null;
  const values = traitValues(model, selected);
  const parts: string[] = [];
  for (const parameter of model.parameters) {
    const value = values[parameter.id];
    if (value === undefined || value === parameter.default) continue;
    const toggle = parameterSwitch(parameter);
    parts.push(toggle ? (value === toggle.on ? parameter.label : `${parameter.label} off`) : parameter.values.find((item) => item.value === value)?.label ?? value);
  }
  return parts.length ? parts.join(" · ") : null;
}

function withoutContext(id: string) {
  return id.split("[", 1)[0]!;
}

const BACKEND_LABELS: Record<string, string> = {
  amazon: "Amazon",
  "amazon-bedrock": "Amazon Bedrock",
  anthropic: "Anthropic",
  apple: "Apple",
  azure: "Azure",
  cursor: "Cursor",
  deepseek: "DeepSeek",
  github: "GitHub",
  "github-copilot": "GitHub Copilot",
  google: "Google",
  groq: "Groq",
  lmstudio: "LM Studio",
  mistral: "Mistral",
  moonshot: "Moonshot",
  ollama: "Ollama",
  openai: "OpenAI",
  opencode: "OpenCode",
  openrouter: "OpenRouter",
  vertex: "Vertex AI",
  xai: "xAI",
  zai: "Z.ai",
};

/** Display name for the service a harness routes a model through (`openrouter` → OpenRouter). */
export function backendLabel(backend: string): string {
  return (
    BACKEND_LABELS[backend.toLowerCase()] ??
    backend
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map((word) => word[0]!.toUpperCase() + word.slice(1))
      .join(" ")
  );
}

/**
 * The model's family for catalogs without backends: the leading name with its
 * version dropped, so `GPT-5.6 Sol 1M High` and `GPT-5.4` share `GPT`.
 */
export function modelFamily(displayName: string): string {
  const word = displayName.trim().split(/\s+/, 1)[0] ?? "";
  const name = word.replace(/[-_.]?\d.*$/, "") || word;
  return name ? name[0]!.toUpperCase() + name.slice(1) : "Other";
}

/** Distinct backends in a catalog. More than one means names alone can be ambiguous. */
export function catalogBackends(catalog: readonly Pick<ProviderModel, "provider">[]): string[] {
  const seen = new Set<string>();
  for (const model of catalog) if (model.provider) seen.add(model.provider);
  return [...seen];
}

/**
 * A short qualifier for a model whose display name repeats under another
 * backend (Grok 4.7 from Cursor and from OpenRouter), or null when the name
 * is already unique.
 */
export function modelQualifier(
  catalog: readonly Pick<ProviderModel, "display_name" | "provider">[],
  model: Pick<ProviderModel, "display_name" | "provider"> | undefined,
): string | null {
  if (!model?.provider) return null;
  const name = model.display_name.trim().toLowerCase();
  const twin = catalog.some(
    (other) => other.provider !== model.provider && other.display_name.trim().toLowerCase() === name,
  );
  return twin ? backendLabel(model.provider) : null;
}

/** Catalogs at or under this size read fine as one list. */
export const MODEL_FLAT_LIMIT = 12;
/** Rows a collapsed section shows before "Show more". */
export const MODEL_SECTION_PREVIEW = 6;

export interface ModelSection<T> {
  key: string;
  /** Null for the single unlabeled section of a small catalog. */
  label: string | null;
  models: T[];
}

/**
 * Splits a catalog into the sections a picker shows. Several backends group
 * by backend; one large backend groups by family; a small catalog stays flat.
 * Order is stable so sections never move as the selection changes: the
 * backend holding the agent's default first, then alphabetical. Families
 * keep catalog order and single models share "Other" at the end.
 */
export function modelSections<T extends Pick<ProviderModel, "id" | "display_name" | "provider" | "is_default">>(
  catalog: readonly T[],
): ModelSection<T>[] {
  const backends = catalogBackends(catalog);
  if (backends.length > 1) {
    const defaultBackend = catalog.find((model) => model.is_default)?.provider;
    const order = [...backends].sort((a, b) =>
      a === defaultBackend ? -1 : b === defaultBackend ? 1 : backendLabel(a).localeCompare(backendLabel(b)),
    );
    const sections = order.map((backend) => ({
      key: `backend:${backend}`,
      label: backendLabel(backend),
      models: catalog.filter((model) => model.provider === backend),
    }));
    const loose = catalog.filter((model) => !model.provider);
    if (loose.length) sections.push({ key: "backend:", label: "Other", models: loose });
    return sections;
  }
  if (catalog.length <= MODEL_FLAT_LIMIT) return [{ key: "all", label: null, models: [...catalog] }];
  const families = new Map<string, T[]>();
  for (const model of catalog) {
    const family = modelFamily(model.display_name);
    const list = families.get(family) ?? [];
    list.push(model);
    families.set(family, list);
  }
  const sections: ModelSection<T>[] = [];
  const other: T[] = [];
  for (const [family, models] of families) {
    if (models.length > 1) sections.push({ key: `family:${family}`, label: family, models });
    else other.push(...models);
  }
  if (other.length) sections.push({ key: "family:", label: "Other", models: other });
  return sections.length > 1 ? sections : [{ key: "all", label: null, models: [...catalog] }];
}

/**
 * Every query word must appear in the name, id or backend, so "grok cursor"
 * narrows to Cursor's Grok models. Names that start with the query rank first.
 */
export function searchModels<T extends Pick<ProviderModel, "id" | "display_name" | "provider">>(
  catalog: readonly T[],
  query: string,
): T[] {
  const search = query.trim().toLowerCase();
  if (!search) return [...catalog];
  const words = search.split(/\s+/);
  const scored: { model: T; rank: number; index: number }[] = [];
  catalog.forEach((model, index) => {
    const name = model.display_name.toLowerCase();
    const haystack = `${name} ${model.id.toLowerCase()} ${model.provider ? backendLabel(model.provider).toLowerCase() : ""}`;
    if (!words.every((word) => haystack.includes(word))) return;
    const rank = name.startsWith(search) ? 0 : name.split(/[\s\-/]+/).some((part) => part.startsWith(words[0]!)) ? 1 : 2;
    scored.push({ model, rank, index });
  });
  return scored.sort((a, b) => a.rank - b.rank || a.index - b.index).map((entry) => entry.model);
}

/** Most recent first, deduplicated, capped. */
export function rememberModel(recent: readonly string[], id: string, limit = 5): string[] {
  return id ? [id, ...recent.filter((item) => item !== id)].slice(0, limit) : [...recent];
}

/** A starred model. The harness is part of the key: the same id can mean different models per harness. */
export interface FavoriteModel {
  kind: string;
  id: string;
  /** Missing on legacy favorites means the regular CLI account. */
  instance?: string;
}

export function isFavorite(favorites: readonly FavoriteModel[], kind: string, id: string, instance = "default"): boolean {
  return favorites.some((item) => item.kind === kind && item.id === id && (item.instance ?? "default") === instance);
}

/** Whether a favorite names this row, directly or through a variant id stored before models were folded into one row. */
export function favoriteMatches(favorite: Pick<FavoriteModel, "id">, model: Pick<ProviderModel, "id" | "resolved_id" | "variants">): boolean {
  if (favorite.id === model.id) return true;
  if (!model.variants?.length) return false;
  return model.resolved_id === favorite.id || model.variants.some((variant) => variant.id === favorite.id || sameCursorModel(variant.id, favorite.id));
}

export function isFavoriteModel(
  favorites: readonly FavoriteModel[],
  kind: string,
  model: Pick<ProviderModel, "id" | "resolved_id" | "variants">,
  instance = "default",
): boolean {
  return favorites.some((item) => item.kind === kind && (item.instance ?? "default") === instance && favoriteMatches(item, model));
}

/** Stars the model by its row id; unstarring also drops any older variant ids that resolve to it. */
export function toggleFavoriteModel(
  favorites: readonly FavoriteModel[],
  kind: string,
  model: Pick<ProviderModel, "id" | "resolved_id" | "variants">,
  instance = "default",
): FavoriteModel[] {
  return isFavoriteModel(favorites, kind, model, instance)
    ? favorites.filter((item) => item.kind !== kind || (item.instance ?? "default") !== instance || !favoriteMatches(item, model))
    : [...favorites, { kind, id: model.id, ...(instance === "default" ? {} : { instance }) }];
}

/** Adds or removes a favorite; new favorites go last so the list keeps the order they were starred in. */
export function toggleFavorite(favorites: readonly FavoriteModel[], kind: string, id: string, instance = "default"): FavoriteModel[] {
  return isFavorite(favorites, kind, id, instance)
    ? favorites.filter((item) => item.kind !== kind || item.id !== id || (item.instance ?? "default") !== instance)
    : [...favorites, { kind, id, ...(instance === "default" ? {} : { instance }) }];
}

/** A discovered catalog is a set of suggestions, not an allowlist. */
export function modelChoices(
  catalog: readonly ProviderModel[],
  selected?: string | null,
  query = "",
) {
  const choices: ModelChoice[] = [
    { id: "", display_name: "Agent default", default_effort: "" },
    ...catalog,
  ];
  if (selected && !findModel(catalog, selected)) {
    choices.splice(1, 0, {
      id: selected,
      display_name: selected,
      custom: true,
    });
  }
  const candidate = customModelId(query);
  return {
    models: query.trim() ? searchModels(choices, query) : choices,
    customId:
      candidate && !choices.some((model) => model.id === candidate)
        ? candidate
        : null,
  };
}
