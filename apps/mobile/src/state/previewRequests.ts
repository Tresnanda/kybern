// Pages agents ask to show (`previews.open_requested`), kept per thread so the preview screen
// or the iPad inspector can open them. No runtime import: `runtime.connect` attaches it.
import { useSyncExternalStore } from "react";
import {
  PREVIEW_OPEN_REQUESTED_NOTIFICATION,
  type KybernClient,
  type PreviewOpenRequestedNotification,
} from "./protocol";

type Request = PreviewOpenRequestedNotification & { at: number };
let requests = new Map<string, Request>();
const listeners = new Set<() => void>();
const requestListeners = new Set<(request: Request) => void>();
const emit = () => listeners.forEach((fn) => fn());

/** Called once per connection from `runtime.connect`. */
export function attachPreviews(client: KybernClient, current: () => boolean) {
  requests = new Map();
  emit();
  client.onNotification(PREVIEW_OPEN_REQUESTED_NOTIFICATION, (raw) => {
    const request = raw as PreviewOpenRequestedNotification;
    if (!current() || !request?.thread_id || typeof request.target !== "string") return;
    const entry = { ...request, at: Date.now() };
    requests = new Map(requests).set(request.thread_id, entry);
    emit();
    requestListeners.forEach((fn) => fn(entry));
  });
}

/** The latest page an agent asked to show in this thread. */
export function usePreviewRequest(threadId: string | undefined) {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    () => (threadId ? requests.get(threadId) : undefined),
  );
}

/** Hear every agent request as it arrives (the app shows a toast or reveals the inspector). */
export function onPreviewRequested(fn: (request: Request) => void) {
  requestListeners.add(fn);
  return () => void requestListeners.delete(fn);
}
