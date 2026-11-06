import { useEffect, useMemo, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { noteClient, noteWritable, subscribeNoteChanges } from "./notes";
import { NoteSession, type NoteTarget } from "./noteSession";
import { errorText, rpc, useApp, useNetworkLive, useThreadLive } from "./runtime";

/**
 * Binds an open note to the live connection: loads it, keeps it in step with
 * other devices, autosaves edits, and saves once more when the screen closes
 * or the app leaves the foreground.
 */
export function useNoteSession(target: NoteTarget) {
  const app = useApp();
  const live = useNetworkLive();
  const threadLive = useThreadLive(target.kind === "thread" ? target.threadId : undefined);
  // Writable while the machine that holds the note answers (`federated.ts`); an away machine's note is read-only.
  // A thread's note lives on the thread's machine.
  const connected = target.kind === "thread" ? threadLive : live && noteWritable(target.kind === "id" ? target.id : undefined);
  const identity =
    target.kind === "id"
      ? `id:${target.id}`
      : target.kind === "thread"
        ? `thread:${target.threadId}`
        : `new:${target.projectId ?? ""}:${target.role ?? ""}`;
  const session = useMemo(
    () =>
      new NoteSession(target, {
        // A thread's note lives on the thread's machine; any other goes to the machine that holds it.
        call: (method, params) => {
          const ids = params as { id?: string; thread_id?: string } | null;
          if (ids?.thread_id) return rpc(method as never, params as never);
          try {
            return noteClient(ids?.id).call(method as never, params as never);
          } catch (e) {
            return Promise.reject(e);
          }
        },
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
    void session.sync();
  }, [session, connected]);
  return { session, ...snapshot, connected };
}
