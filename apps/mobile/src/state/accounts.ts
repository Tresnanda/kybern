// The agents' accounts on the computer (`providers.accounts.list`). Read when a
// surface that shows them opens and after every change; listing probes each
// account, so nothing polls. Sign-in and removal stay on the computer.
import { useSyncExternalStore } from "react";
import type { AccountSummary, KybernClient, ProviderKind, Settings } from "./protocol";
import { errorText, onClientAttach, onEnvironmentReset } from "./runtime";
import { attachLate } from "./lateAttach";
import { saveSettings } from "./settings";

type State = { accounts: AccountSummary[]; loaded: boolean; unsupported: boolean; error: string };
let state: State = { accounts: [], loaded: false, unsupported: false, error: "" };
const listeners = new Set<() => void>();
let client: KybernClient | null = null;
let inflight: Promise<void> | null = null;

function publish(patch: Partial<State>) {
  state = { ...state, ...patch };
  listeners.forEach((fn) => fn());
}

function attach(next: KybernClient) {
  client = next;
  inflight = null;
  next.onNotification("providers.accounts.login.changed", (params) => {
    if ((params as { phase?: string } | null)?.phase === "signed_in") void loadAccounts();
  });
}
onClientAttach(attach);
onEnvironmentReset(() => {
  client = null;
  inflight = null;
  publish({ accounts: [], loaded: false, unsupported: false, error: "" });
});

/** Read the list; concurrent asks share one call. */
export function loadAccounts(): Promise<void> {
  const active = client;
  if (!active) return Promise.resolve();
  if (inflight) return inflight;
  inflight = active
    .call("providers.accounts.list", {})
    .then((result) => {
      if (client === active) publish({ accounts: result.accounts, loaded: true, unsupported: false, error: "" });
    })
    .catch((e) => {
      if (client !== active) return;
      const text = errorText(e);
      if (/method not found|-32601/i.test(text)) publish({ loaded: true, unsupported: true, error: "" });
      else publish({ error: `Unable to read accounts. ${text}` });
    })
    .finally(() => {
      if (client === active) inflight = null;
    });
  return inflight;
}

/** Rename or recolour an account. Throws the daemon's error for the caller to word. */
export async function updateAccount(account: AccountSummary, patch: { name?: string; color?: string }) {
  if (!client) throw new Error("Connect to your computer to continue.");
  const updated = await client.call("providers.accounts.update", {
    kind: account.provider.kind,
    instance: account.provider.instance,
    ...patch,
  });
  publish({
    accounts: state.accounts.map((a) =>
      a.provider.kind === updated.provider.kind && a.provider.instance === updated.provider.instance ? updated : a,
    ),
  });
}

/** Make an account its agent's default. The CLI account clears `default_account`, so "default" is never stored. */
export async function makeDefaultAccount(settings: Settings, account: AccountSummary) {
  const kind: ProviderKind = account.provider.kind;
  const current = settings.providers[kind] ?? { env: {} };
  const instance = account.provider.instance;
  const saved = await saveSettings({
    ...settings,
    providers: { ...settings.providers, [kind]: { ...current, default_account: instance === "default" ? null : instance } },
  });
  if (saved) await loadAccounts();
  return saved;
}

/** Swatches an account can take (`ProviderAccount.color`). */
export const ACCOUNT_COLORS = ["blue", "green", "purple", "pink", "teal", "amber"] as const;

const read = () => state;
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
export function useAccounts() {
  return useSyncExternalStore(subscribe, read, read);
}

attachLate(attach, () => {});
