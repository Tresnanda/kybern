import type { ProviderModel } from "./types.ts";

export type ModelChoice = Pick<
  ProviderModel,
  "id" | "display_name" | "default_effort"
> & {
  custom?: true;
};

/** Model IDs are opaque to Kybern. Preserve provider prefixes, versions and aliases. */
export function customModelId(value: string): string | null {
  const id = value.trim();
  return id && !/[\s\p{Cc}]/u.test(id) ? id : null;
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
  if (selected && !catalog.some((model) => model.id === selected)) {
    choices.splice(1, 0, {
      id: selected,
      display_name: selected,
      custom: true,
    });
  }
  const search = query.trim().toLowerCase();
  const candidate = customModelId(query);
  return {
    models: choices.filter((model) =>
      `${model.display_name} ${model.id}`.toLowerCase().includes(search),
    ),
    customId:
      candidate && !choices.some((model) => model.id === candidate)
        ? candidate
        : null,
  };
}
