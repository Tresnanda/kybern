import type { ProviderModel } from "./types.ts";

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
export function findModel<T extends Pick<ProviderModel, "id" | "resolved_id">>(
  catalog: readonly T[],
  id: string | null | undefined,
): T | undefined {
  if (!id) return undefined;
  const base = withoutContext(id);
  return (
    catalog.find((model) => model.id === id) ??
    catalog.find((model) => model.resolved_id === id) ??
    catalog.find((model) => sameCursorModel(model.id, id)) ??
    catalog.find((model) => !!model.resolved_id && withoutContext(model.resolved_id) === base)
  );
}

/** Older Cursor threads stored each effort as an opaque variant selector. */
function cursorModelKey(selector: string): string | undefined {
  if (!selector.startsWith("cursor-model:")) return undefined;
  try {
    const encoded = selector.slice(13).replaceAll("-", "+").replaceAll("_", "/");
    const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    const selection = JSON.parse(new TextDecoder().decode(bytes)) as {id: string; params: {id: string; value: string}[]};
    if (typeof selection.id !== "string" || !Array.isArray(selection.params)) return undefined;
    const params = selection.params.filter((param) => !["effort", "reason_effort", "reasoning_effort", "reasoningEffort"].includes(param.id));
    return JSON.stringify([selection.id, params.sort((a, b) => a.id.localeCompare(b.id))]);
  } catch { return undefined; }
}

function sameCursorModel(left: string, right: string): boolean {
  const key = cursorModelKey(left);
  return key !== undefined && key === cursorModelKey(right);
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
