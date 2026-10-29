// Which agents a machine can run for you (ADE-86 dogfood). A harness that exists on a machine may still be signed out
// there, and a fork, a move or a new thread that starts a turn with it fails at once with "Failed to authenticate".
// Only Claude, Codex and Cursor have an account to sign in to; omp, OpenCode and pi use whatever provider keys the
// machine has, so they are never reported as signed out (see `signedInOf`).
import { findModel, selectedVariant } from "./models.ts";
import { PROVIDER_DISPLAY_NAME } from "./types.ts";
import type { AccountSummary, HarnessSummary, ProviderKind, ProviderModel } from "./types.ts";

/** The harnesses with an account. */
export const SIGN_IN_KINDS: readonly ProviderKind[] = ["claude-code", "codex", "cursor"];

export const hasSignIn = (kind: ProviderKind): boolean => SIGN_IN_KINDS.includes(kind);

export interface MachineAgent {
  kind: ProviderKind;
  label: string;
  /** The harness is installed there. */
  available: boolean;
  /** `false` only when the machine said so for a harness with an account; `null` when unknown or not applicable. */
  signedIn: boolean | null;
}

/** Whether the default account of `kind` is signed in, from a machine's `providers.accounts.list`; null when it cannot be told. */
export function signedInOf(kind: ProviderKind, accounts: readonly AccountSummary[] | null | undefined): boolean | null {
  if (!hasSignIn(kind) || !accounts) return null;
  const own = accounts.filter((account) => account.provider.kind === kind);
  if (own.length === 0) return null;
  if (own.some((account) => account.status === "signed_in")) return true;
  return own.some((account) => account.status === "signed_out" || account.status === "needs_sign_in") ? false : null;
}

/** The machine's harnesses (`machines.info`) with their sign-in state, installed ones first and in the harness order. */
export function machineAgents(harnesses: readonly HarnessSummary[], accounts: readonly AccountSummary[] | null | undefined): MachineAgent[] {
  return harnesses
    .map((harness) => ({
      kind: harness.kind,
      label: PROVIDER_DISPLAY_NAME[harness.kind] ?? harness.kind,
      available: harness.available,
      signedIn: hasSignIn(harness.kind) ? (signedInOf(harness.kind, accounts) ?? harness.signed_in ?? null) : null,
    }))
    .sort((a, b) => Number(b.available) - Number(a.available));
}

/** Can start a turn: installed and not known to be signed out. */
export const agentUsable = (agent: MachineAgent): boolean => agent.available && agent.signedIn !== false;

/**
 * The agent a new thread on this machine should use: `preferred` (the agent of the thread being forked or the one chosen
 * in the composer) when it can run, else the first one signed in, else the first one that can run. Null when none can.
 */
export function defaultAgent(agents: readonly MachineAgent[], preferred?: ProviderKind | null): ProviderKind | null {
  const preferredAgent = preferred ? agents.find((agent) => agent.kind === preferred) : undefined;
  if (preferredAgent && agentUsable(preferredAgent)) return preferredAgent.kind;
  return (agents.find((agent) => agent.available && agent.signedIn === true) ?? agents.find(agentUsable))?.kind ?? null;
}

/** "Claude Code · signed out on instabox", or the plain name when nothing is wrong. */
export function agentLine(agent: MachineAgent, machineName: string): string {
  if (!agent.available) return `${agent.label} · not installed on ${machineName}`;
  return agent.signedIn === false ? `${agent.label} · signed out on ${machineName}` : agent.label;
}

/** The sheet's warning when no agent of the machine can run a turn; null when one can. */
export function noAgentWarning(agents: readonly MachineAgent[], machineName: string): string | null {
  if (defaultAgent(agents) !== null) return null;
  return agents.some((agent) => agent.available)
    ? `No agent is signed in on ${machineName}. Sign in there (Settings → Machines) before the first message, or it will fail.`
    : `No agent is installed on ${machineName}.`;
}

/**
 * The second line of a machine in the fork and move sheets: "Offline · waits until it’s back", the agents installed there
 * ("Claude Code, Codex"), or "Online" while they are not known yet.
 */
export function machineChoiceDetail(online: boolean, agents: readonly MachineAgent[] | null | undefined): string {
  if (!online) return "Offline · waits until it’s back";
  if (!agents) return "Online";
  const installed = agents.filter((agent) => agent.available).map((agent) => agent.label);
  return installed.length > 0 ? installed.join(", ") : "No agents installed";
}

/** The model and effort a new thread on another machine starts with; null leaves the choice to that machine. */
export interface ModelChoice {
  model: string | null;
  effort: string | null;
}

/** A choice of `kind` (the source thread's, or the user's own pick in the sheet). */
export interface KindedChoice extends ModelChoice {
  kind: ProviderKind;
}

/** The efforts a model (or the variant `selector` names) offers. */
function offeredEfforts(model: ProviderModel, selector: string): string[] {
  const variant = selectedVariant(model, selector);
  return variant?.efforts?.length ? variant.efforts : model.efforts ?? [];
}

/** `choice` on this catalog: its model when the machine has it, with its effort when that model offers it, else the model's default effort. */
function onCatalog(catalog: readonly ProviderModel[], choice: ModelChoice): ModelChoice | null {
  const model = choice.model ? findModel(catalog, choice.model) : undefined;
  if (!model || !choice.model) return null;
  const efforts = offeredEfforts(model, choice.model);
  if (efforts.length === 0) return { model: choice.model, effort: null };
  const effort = choice.effort && efforts.includes(choice.effort) ? choice.effort : selectedVariant(model, choice.model)?.default_effort ?? model.default_effort ?? null;
  return { model: choice.model, effort };
}

/**
 * The model and effort a fork or move to another machine starts with, for agent `kind` and that machine's `catalog` of it.
 * The user's pick when it is for this agent and the machine has the model; else the source thread's model and effort
 * when it ran the same agent and the machine has that model; else the machine's default model with its default effort.
 * An empty catalog (not known yet, or a harness without one) leaves both to the machine.
 */
export function targetModel(catalog: readonly ProviderModel[], kind: ProviderKind | null, source: KindedChoice | null, picked?: KindedChoice | null): ModelChoice {
  const none = { model: null, effort: null };
  if (!kind || catalog.length === 0) return none;
  if (picked?.kind === kind) {
    const own = onCatalog(catalog, picked);
    if (own) return own;
  }
  if (source?.kind === kind) {
    const same = onCatalog(catalog, source);
    if (same) return same;
  }
  const fallback = catalog.find((model) => model.is_default) ?? catalog[0]!;
  const efforts = offeredEfforts(fallback, fallback.id);
  return { model: fallback.id, effort: efforts.length ? fallback.default_effort ?? null : null };
}
