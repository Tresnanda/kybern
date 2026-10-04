import { useEffect, useMemo, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { subscribeNoteChanges } from "./notes";
import { NoteSession, type NoteTarget } from "./noteSession";
import { errorText, rpc, useApp } from "./runtime";

/**
 * Binds an open note to the live connection: loads it, keeps it in step with
 * other devices, autosaves edits, and saves once more when the screen closes
 * or the app leaves the foreground.
 */
export function useNoteSession(target: NoteTarget) {
  const app = useApp();
  const connected = app.status === "open";
  const identity =
    target.kind === "id"
      ? `id:${target.id}`
      : target.kind === "thread"
        ? `thread:${target.threadId}`
        : `new:${target.projectId ?? ""}`;
  const session = useMemo(
    () =>
      new NoteSession(target, {
        call: (method, params) => rpc(method as never, params as never),
        subscribeChanges: subscribeNoteChanges,
        scope: app.activeId ?? "",
        errorText,
      }),
    // A new target or computer is a new note.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [identity, app.activeId],
  );
  const snapshot = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );
  useEffect(() => {
    session.attach();
    const sub = AppState.addEventListener("change", (next) => {
      if (next !== "active") void session.flush();
    });
    return () => {
      sub.remove();
      void session.dispose();
    };
  }, [session]);
  useEffect(() => {
    if (connected) void session.sync();
  }, [session, connected]);
  return { session, ...snapshot, connected };
}
