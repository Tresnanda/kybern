// Computer use on the computer: CuaDriver's status, what agents learned about
// each app (app notes), and the live frame of a thread using an app. Setup
// (install, permissions) needs the computer itself, so the phone only reads it.
import { useSyncExternalStore } from "react";
import type { ComputerFrame, ComputerNote, ComputerStatus, KybernClient } from "./protocol";
import { errorText, onClientAttach, onEnvironmentReset } from "./runtime";
import { attachLate } from "./lateAttach";

type State = { status: ComputerStatus | null; notes: ComputerNote[] | null; error: string };
let state: State = { status: null, notes: null, error: "" };
const listeners = new Set<() => void>();
let client: KybernClient | null = null;

function publish(patch: Partial<State>) {
  state = { ...state, ...patch };
  listeners.forEach((fn) => fn());
}

function attach(next: KybernClient) {
  client = next;
}
onClientAttach(attach);
onEnvironmentReset(() => {
  client = null;
  publish({ status: null, notes: null, error: "" });
});

/** Read CuaDriver's status and the app notes. */
export async function loadComputerUse() {
  const active = client;
  if (!active) return;
  try {
    const [status, notes] = await Promise.all([
      active.call("computer.status", {}),
      active.call("computer.notes.list", {}),
    ]);
    if (client === active) publish({ status, notes: notes.notes, error: "" });
  } catch (e) {
    if (client === active) publish({ error: `Unable to read computer use. ${errorText(e)}` });
  }
}

/** Replace one app's note; empty text deletes it. */
export async function saveComputerNote(note: Pick<ComputerNote, "bundle_id" | "app">, text: string) {
  if (!client) throw new Error("Connect to your computer to continue.");
  const result = await client.call("computer.notes.set", { bundle_id: note.bundle_id, app: note.app, text });
  publish({ notes: result.notes });
}

/**
 * Polls `computer.frame` for one thread: one request at a time, ~1 s apart, only
 * while `start` is in effect. Frames are handed to `accept` and never stored.
 */
export function pollFrames(threadId: string, accept: (frame: ComputerFrame) => void, interval = 1000) {
  let stopped = false;
  let after: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const started = Date.now();
  const tick = async () => {
    const active = client;
    if (stopped || !active) return;
    try {
      const { frame } = await active.call("computer.frame", { thread_id: threadId, after });
      if (frame && !stopped && client === active) {
        after = frame.seq;
        if (Date.parse(frame.captured_at) >= started - 5 * 60_000) accept(frame);
      }
    } catch {
      // The next tick tries again.
    } finally {
      if (!stopped) timer = setTimeout(() => void tick(), interval);
    }
  };
  void tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

const read = () => state;
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
export function useComputerUse() {
  return useSyncExternalStore(subscribe, read, read);
}

attachLate(attach, () => {});
