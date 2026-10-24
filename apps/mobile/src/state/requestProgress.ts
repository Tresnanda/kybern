// Live state of the daemon's multi-step request cards (sign-in, macOS permission, a question with a
// deadline), keyed by approval id. The daemon pushes `requests.progress`; the method of the same name
// lists the live cards on connect and when a card mounts. Never persisted: an entry goes when its
// approval resolves (the card unmounts) or the connection changes.
import { useSyncExternalStore } from "react";
import type { KybernClient } from "../../../../packages/kybern-client/src/client";
import { REQUESTS_PROGRESS_NOTIFICATION, type RequestProgress } from "./protocol";

const items = new Map<string, RequestProgress>();
const listeners = new Set<() => void>();
let client: KybernClient | null = null;
let isCurrent = () => false;
const emit = () => listeners.forEach((listener) => listener());

const stale = (kept: RequestProgress | undefined, next: RequestProgress) => {
  if (!kept) return false;
  const a = Date.parse(kept.updated_at);
  const b = Date.parse(next.updated_at);
  return !Number.isNaN(a) && !Number.isNaN(b) && b < a;
};

function apply(next: RequestProgress) {
  // A run-in-terminal item has no card: the terminal is on the computer.
  if (next.kind === "terminal" || stale(items.get(next.approval_id), next)) return;
  items.set(next.approval_id, next);
  emit();
}

/** Follow one connection's request progress. Called with the other live feeds when the client changes. */
export function attachRequestProgress(next: KybernClient, current: () => boolean) {
  client = next;
  isCurrent = current;
  items.clear();
  emit();
  next.onNotification(REQUESTS_PROGRESS_NOTIFICATION, (params) => {
    if (current() && client === next && params && typeof params === "object") apply(params as RequestProgress);
  });
  next.onStatus((status) => {
    if (status === "open" && current() && client === next) void refreshRequestProgress();
  });
}

/** Read the live cards (one thread's, or all) and fold them in. An older daemon has none. */
export async function refreshRequestProgress(threadId?: string) {
  const active = client;
  if (!active || !isCurrent() || active.status !== "open") return;
  try {
    const { items: list } = await active.call("requests.progress", threadId ? { thread_id: threadId } : {});
    if (active === client) list.forEach(apply);
  } catch {
    // No request progress on this daemon: cards keep their asking state.
  }
}

export function forgetRequestProgress(approvalId: string) {
  if (items.delete(approvalId)) emit();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export function useRequestProgress(approvalId: string): RequestProgress | null {
  return useSyncExternalStore(subscribe, () => items.get(approvalId) ?? null);
}

/** A card's button that is not an answer. Throws the daemon's sentence for the card to show. */
export async function actOnRequest(approvalId: string, action: string, value?: string) {
  if (!client || !isCurrent()) throw new Error("Your computer is not connected. Reconnect, then try again.");
  await client.call("requests.act", { approval_id: approvalId, action, ...(value === undefined ? {} : { value }) });
}
