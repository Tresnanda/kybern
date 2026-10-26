// The Coordinator's settings as both clients show and edit them: the global defaults in
// Settings › Delegation, a project's overrides in its Project tab or sheet, and the
// resolver the daemon uses (`OrchestrationSettings::effective_for`), mirrored here so a
// client can say what is in force without asking. The copy lives here too.
import { findModel } from "./models.ts";
import { rotationBudgetLabel } from "./rotation.ts";
import {
  PROVIDER_DISPLAY_NAME,
  type CoordinatorOverrides,
  type CoordinatorRole,
  type DefaultOverride,
  type DelegationWorkspace,
  type EffectiveCoordinatorSettings,
  type LeadAutonomy,
  type OrchestrationSettings,
  type ProviderStatus,
  type RoleDefault,
  type RoleDefaults,
} from "./types.ts";

/** The kinds of work with a default model, in the order both clients list them. */
export const COORDINATOR_ROLES: readonly { role: CoordinatorRole; label: string }[] = [
  { role: "research", label: "Research" },
  { role: "implementation", label: "Implementation" },
  { role: "review", label: "Review" },
  { role: "design", label: "Design" },
  { role: "test", label: "Test" },
];

export const AUTONOMY_OPTIONS: readonly { value: LeadAutonomy; label: string; hint: string }[] = [
  { value: "act", label: "Act", hint: "Starts work right away and reports when it's done." },
  { value: "propose_large", label: "Propose large", hint: "Small fixes start right away. Larger work and protocol changes get a plan first." },
  { value: "propose_first", label: "Propose all", hint: "Proposes a plan before any work." },
];

export const WORKSPACE_OPTIONS: readonly { value: DelegationWorkspace; label: string }[] = [
  { value: "shared", label: "This checkout" },
  { value: "worktree", label: "Own worktree" },
];

export const COORDINATOR_SETTINGS_COPY = {
  section: "Coordinator",
  defaultsSection: "Coordinator defaults",
  autonomy: "Before starting work",
  workspace: "Agents work in",
  push: "Push and open pull requests without asking",
  pushDetail: "Merging a pull request always asks.",
  models: "Models for each kind of work",
  useDefault: "Use the default",
  sameAsCoordinator: "Same as the Coordinator",
  defaultsFrom: "Defaults come from Settings › Delegation",
  reset: "Reset",
  resetTitle: "Reset this project's Coordinator settings?",
  resetDetail: "It goes back to the defaults in Settings › Delegation.",
  redo: "Redo setup",
  redoTitle: "Redo setup?",
  redoDetail: "The Coordinator will interview you again. Your brief stays until you save a new one.",
  saveFailed: "Unable to save the Coordinator settings. Check the connection and try again.",
  redoFailed: "Unable to redo setup",
} as const;

/** Built-in values, used when neither the project nor Settings sets one (as in the daemon). */
export const BUILTIN_COORDINATOR_SETTINGS: EffectiveCoordinatorSettings = {
  role_defaults: {},
  lead_autonomy: "propose_large",
  lead_workspace: "shared",
  lead_push_without_asking: false,
  lead_max_children: 6,
  rotation_budget_tokens: 200_000,
};

export function autonomyHint(value: LeadAutonomy): string {
  return AUTONOMY_OPTIONS.find((option) => option.value === value)?.hint ?? "";
}

/** Project override, then the global setting, then the built-in default. A project role replaces the global entry for that role. */
export function effectiveCoordinatorSettings(
  global: Partial<OrchestrationSettings> | null | undefined,
  project: CoordinatorOverrides | null | undefined,
): EffectiveCoordinatorSettings {
  const role_defaults: RoleDefaults = { ...(global?.role_defaults ?? {}) };
  for (const [role, value] of Object.entries(project?.role_defaults ?? {}) as [CoordinatorRole, RoleDefault][]) role_defaults[role] = value;
  return {
    role_defaults,
    lead_autonomy: project?.lead_autonomy ?? global?.lead_autonomy ?? BUILTIN_COORDINATOR_SETTINGS.lead_autonomy,
    lead_workspace: project?.lead_workspace ?? global?.lead_workspace ?? BUILTIN_COORDINATOR_SETTINGS.lead_workspace,
    lead_push_without_asking: project?.lead_push_without_asking ?? global?.lead_push_without_asking ?? BUILTIN_COORDINATOR_SETTINGS.lead_push_without_asking,
    lead_max_children: project?.lead_max_children ?? global?.lead_max_children ?? BUILTIN_COORDINATOR_SETTINGS.lead_max_children,
    rotation_budget_tokens: project?.rotation_budget_tokens ?? global?.rotation_budget_tokens ?? BUILTIN_COORDINATOR_SETTINGS.rotation_budget_tokens,
  };
}

/** A role default with its empty fields dropped; null when nothing is left. */
export function cleanRoleDefault(value: RoleDefault | null | undefined): RoleDefault | null {
  if (!value) return null;
  const out: RoleDefault = {};
  if (value.provider) out.provider = { kind: value.provider.kind, instance: value.provider.instance || "default" };
  if (value.model?.trim()) out.model = value.model.trim();
  if (value.effort?.trim()) out.effort = value.effort.trim();
  return out.provider || out.model || out.effort ? out : null;
}

/**
 * The whole override object to send with `projects.update { coordinator }`, which
 * replaces what the project had: unset fields are left out (they follow Settings), and
 * an override with nothing in it is `null`, which clears it.
 */
export function cleanOverrides(value: CoordinatorOverrides | null | undefined): CoordinatorOverrides | null {
  if (!value) return null;
  const out: CoordinatorOverrides = {};
  const roles: RoleDefaults = {};
  for (const { role } of COORDINATOR_ROLES) {
    const cleaned = cleanRoleDefault(value.role_defaults?.[role]);
    if (cleaned) roles[role] = cleaned;
  }
  if (Object.keys(roles).length) out.role_defaults = roles;
  if (value.lead_autonomy) out.lead_autonomy = value.lead_autonomy;
  if (value.lead_workspace) out.lead_workspace = value.lead_workspace;
  if (typeof value.lead_push_without_asking === "boolean") out.lead_push_without_asking = value.lead_push_without_asking;
  if (typeof value.lead_max_children === "number") out.lead_max_children = value.lead_max_children;
  if (typeof value.rotation_budget_tokens === "number") out.rotation_budget_tokens = value.rotation_budget_tokens;
  return Object.keys(out).length ? out : null;
}

export type CoordinatorField = "lead_autonomy" | "lead_workspace" | "lead_push_without_asking" | "rotation_budget_tokens";

/** The project's overrides with one field set (or, with `null`, reset to the default). */
export function withOverrideField<K extends CoordinatorField>(current: CoordinatorOverrides | null | undefined, field: K, value: CoordinatorOverrides[K] | null): CoordinatorOverrides | null {
  return cleanOverrides({ ...(current ?? {}), [field]: value ?? undefined });
}

/** The project's overrides with one role's default set, or with `null` removed (it then follows Settings). */
export function withRoleOverride(current: CoordinatorOverrides | null | undefined, role: CoordinatorRole, value: RoleDefault | null): CoordinatorOverrides | null {
  const roles: RoleDefaults = { ...(current?.role_defaults ?? {}) };
  if (value) roles[role] = value;
  else delete roles[role];
  return cleanOverrides({ ...(current ?? {}), role_defaults: roles });
}

/** The global settings with one role's default set or cleared. */
export function withGlobalRoleDefault(current: OrchestrationSettings, role: CoordinatorRole, value: RoleDefault | null): OrchestrationSettings {
  const roles: RoleDefaults = { ...(current.role_defaults ?? {}) };
  const cleaned = cleanRoleDefault(value);
  if (cleaned) roles[role] = cleaned;
  else delete roles[role];
  return { ...current, role_defaults: roles };
}

/** A model's catalog name, "Opus 5.5", else its id. */
export function modelDisplayName(providers: readonly Pick<ProviderStatus, "kind" | "models">[], kind: string | null | undefined, model: string): string {
  const catalog = providers.find((provider) => provider.kind === kind)?.models ?? [];
  return findModel(catalog, model)?.display_name ?? model;
}

/** "Opus 5.5 · high", "Codex" for a harness without a model, or null for an empty default. */
export function roleDefaultLabel(value: RoleDefault | null | undefined, providers: readonly Pick<ProviderStatus, "kind" | "models">[]): string | null {
  const cleaned = cleanRoleDefault(value);
  if (!cleaned) return null;
  const kind = cleaned.provider?.kind;
  const name = cleaned.model ? modelDisplayName(providers, kind, cleaned.model) : kind ? PROVIDER_DISPLAY_NAME[kind] ?? kind : null;
  return [name, cleaned.effort].filter(Boolean).join(" · ") || null;
}

/** What a role's chip in a project says. */
export type RoleChip =
  /** The project sets this role. */
  | { kind: "set"; label: string; provider: RoleDefault["provider"] }
  /** Settings › Delegation sets it; the project follows. */
  | { kind: "inherited"; label: string; provider: RoleDefault["provider"] }
  /** Nobody sets it: children use the Coordinator's own harness and model. */
  | { kind: "coordinator"; label: string };

/** The chip for a role in a project's section (`scope` "project") or in Settings ("global"). */
export function roleChip(
  role: CoordinatorRole,
  global: Partial<OrchestrationSettings> | null | undefined,
  project: CoordinatorOverrides | null | undefined,
  providers: readonly Pick<ProviderStatus, "kind" | "models">[],
  scope: "project" | "global",
): RoleChip {
  const inProject = scope === "project";
  const own = cleanRoleDefault(inProject ? project?.role_defaults?.[role] : global?.role_defaults?.[role]);
  if (own) return { kind: "set", label: roleDefaultLabel(own, providers) ?? "", provider: own.provider };
  const inherited = inProject ? cleanRoleDefault(global?.role_defaults?.[role]) : null;
  if (inherited) return { kind: "inherited", label: `Default · ${roleDefaultLabel(inherited, providers)}`, provider: inherited.provider };
  return { kind: "coordinator", label: COORDINATOR_SETTINGS_COPY.sameAsCoordinator };
}

/** Readable value of one field of a settings proposal (`SettingChange.old` / `new`). */
export function settingValueLabel(path: string, value: unknown, providers: readonly Pick<ProviderStatus, "kind" | "models">[]): string {
  if (value === null || value === undefined) return "Default";
  if (path === "lead_autonomy") return AUTONOMY_OPTIONS.find((option) => option.value === value)?.label ?? String(value);
  if (path === "lead_workspace") return WORKSPACE_OPTIONS.find((option) => option.value === value)?.label ?? String(value);
  if (path === "lead_push_without_asking") return value === true ? "Without asking" : "Ask first";
  if (path === "rotation_budget_tokens") return typeof value === "number" ? rotationBudgetLabel(value) : String(value);
  if (path === "lead_max_children") return typeof value === "number" ? `${value} ${value === 1 ? "agent" : "agents"}` : String(value);
  if (path.startsWith("role_defaults.")) {
    if (typeof value !== "object") return String(value);
    return roleDefaultLabel(value as RoleDefault, providers) ?? "Default";
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** "Instead of the Sonnet 5.5 default: <reason>" under a delegation that set its role's default aside. */
export function defaultOverrideText(override: DefaultOverride, providers: readonly Pick<ProviderStatus, "kind" | "models">[]): string {
  const name = override.model ? modelDisplayName(providers, override.provider.kind, override.model) : PROVIDER_DISPLAY_NAME[override.provider.kind] ?? override.provider.kind;
  const reason = override.reason.trim();
  return reason ? `Instead of the ${name} default: ${reason}` : `Instead of the ${name} default`;
}
