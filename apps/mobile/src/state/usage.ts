// Plan limits for each agent and account (`usage.limits`), kept live by
// `usage.limits.changed`. The daemon answers from its cache at once and re-reads
// stale providers in the background; their new values arrive as the notification.
import { useSyncExternalStore } from "react";
import {
  USAGE_LIMITS_CHANGED_NOTIFICATION,
  type KybernClient,
  type ProviderLimits,
  type UsageLimitsResult,
} from "./protocol";
import {
  errorText,
  onClientAttach,
  onEnvironmentReset,
  onSubscriptionReady,
} from "./runtime";
import { attachLate } from "./lateAttach";

type State = { limits: UsageLimitsResult | null; error: string; loading: boolean };
let state: State = { limits: null, error: "", loading: false };
const listeners = new Set<() => void>();
let client: KybernClient | null = null;
let isCurrent = () => false;

function publish(patch: Partial<State>) {
  state = { ...state, ...patch };
  listeners.forEach((fn) => fn());
}

function attach(next: KybernClient, current: () => boolean) {
  client = next;
  isCurrent = current;
  next.onNotification(USAGE_LIMITS_CHANGED_NOTIFICATION, (params) => {
    if (!current() || !params || typeof params !== "object") return;
    publish({ limits: mergeLimits(state.limits, params as UsageLimitsResult), error: "" });
  });
}
onClientAttach(attach);
onSubscriptionReady(() => void loadUsageLimits());
onEnvironmentReset(() => {
  client = null;
  publish({ limits: null, error: "", loading: false });
});

/** Ask for the limits; `refresh` re-reads every provider now (pull to refresh, opening Usage). */
export async function loadUsageLimits(refresh = false) {
  const active = client;
  if (!active) return;
  publish({ loading: true });
  try {
    const limits = await active.call("usage.limits", {
      cached: true,
      all_accounts: true,
      ...(refresh ? { refresh: true } : {}),
    });
    if (client === active && isCurrent())
      publish({ limits: mergeLimits(state.limits, limits), error: "" });
  } catch (e) {
    if (client === active && isCurrent())
      publish({ error: `Unable to read plan limits. ${errorText(e)}` });
  } finally {
    if (client === active) publish({ loading: false });
  }
}

const read = () => state;
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
export function useUsageLimits() {
  return useSyncExternalStore(subscribe, read, read);
}

/** A newer answer replaces the default entries; per-account entries it leaves out stay as they were. */
export function mergeLimits(
  previous: UsageLimitsResult | null,
  next: UsageLimitsResult,
): UsageLimitsResult {
  if (!previous?.accounts?.length || !next.accounts) return next.accounts ? next : { ...next, accounts: previous?.accounts };
  const key = (entry: ProviderLimits) => `${entry.provider}:${entry.instance ?? ""}`;
  const merged = new Map(previous.accounts.map((entry) => [key(entry), entry]));
  for (const entry of next.accounts) merged.set(key(entry), entry);
  return { ...next, accounts: [...merged.values()] };
}

/** Every limit card to show: the per-account entries when there are any for a kind, else the default one. */
export function limitCards(result: UsageLimitsResult | null): ProviderLimits[] {
  if (!result) return [];
  const accounts = result.accounts ?? [];
  const withAccounts = new Set(accounts.map((entry) => entry.provider));
  return [
    ...result.providers.filter((entry) => !withAccounts.has(entry.provider)),
    ...accounts,
  ];
}

attachLate(attach, () => void loadUsageLimits());
