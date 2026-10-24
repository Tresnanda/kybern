// The computer's settings, one store for every Settings page. Read on every
// (re)subscription, kept live by `settings.changed` (another client, the CLI, an
// "Always allow" on an approval). Writes show at once and go back if refused.
import { useSyncExternalStore } from "react";
import type { KybernClient, Settings } from "./protocol";
import {
  errorText,
  onClientAttach,
  onEnvironmentReset,
  onSubscriptionReady,
} from "./runtime";
import { attachLate } from "./lateAttach";

export const SETTINGS_CHANGED_NOTIFICATION = "settings.changed";

type State = { settings: Settings | null; error: string; saving: boolean };
let state: State = { settings: null, error: "", saving: false };
const listeners = new Set<() => void>();
let client: KybernClient | null = null;
let isCurrent = () => false;
/** Bumped by every value that is newer than a read in flight. */
let revision = 0;

function publish(patch: Partial<State>) {
  state = { ...state, ...patch };
  listeners.forEach((fn) => fn());
}

function attach(next: KybernClient, current: () => boolean) {
  client = next;
  isCurrent = current;
  next.onNotification(SETTINGS_CHANGED_NOTIFICATION, (params) => {
    const settings = (params as { settings?: Settings } | null)?.settings;
    if (!current() || !settings) return;
    revision++;
    publish({ settings, error: "" });
  });
}
onClientAttach(attach);
onSubscriptionReady(() => void loadSettings());
onEnvironmentReset(() => {
  revision++;
  client = null;
  publish({ settings: null, error: "", saving: false });
});

/** Read the settings again; a newer `settings.changed` or save wins over this read. */
export async function loadSettings() {
  const active = client;
  if (!active) return;
  const at = revision;
  try {
    const settings = await active.call("settings.get", {});
    if (client === active && isCurrent() && revision === at)
      publish({ settings, error: "" });
  } catch (e) {
    if (client === active && isCurrent())
      publish({ error: `Unable to read settings. ${errorText(e)}` });
  }
}

/**
 * Save the whole document. The new value shows at once; a refusal puts the
 * previous one back and says why. Resolves false when nothing was saved.
 */
export async function saveSettings(next: Settings): Promise<boolean> {
  const active = client;
  const previous = state.settings;
  if (!active || !previous) return false;
  revision++;
  const at = revision;
  publish({ settings: next, saving: true, error: "" });
  try {
    const saved = await active.call("settings.update", { settings: next });
    if (client === active && revision === at) publish({ settings: saved });
    return true;
  } catch (e) {
    if (client === active && revision === at)
      publish({
        settings: previous,
        error: `Unable to save the setting. Check the connection and try again. ${errorText(e)}`,
      });
    return false;
  } finally {
    if (client === active) publish({ saving: false });
  }
}

/** Change part of the settings: `updateSettings((s) => ({ ...s, generate_titles: true }))`. */
export function updateSettings(change: (current: Settings) => Settings) {
  if (!state.settings) return Promise.resolve(false);
  return saveSettings(change(state.settings));
}

export function clearSettingsError() {
  if (state.error) publish({ error: "" });
}

const read = () => state;
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
export function useSettings() {
  return useSyncExternalStore(subscribe, read, read);
}

attachLate(attach, () => void loadSettings());
