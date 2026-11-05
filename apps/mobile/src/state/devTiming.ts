// Development-only timings for #248 ("threads and data load instantly"):
//
// - "thread": a tap on a thread row (`markThreadTap`) to the first transcript content the thread
//   screen renders (`markThreadContent`), with whether that content came from a cache.
// - "list": a cold start (this module's first import, close to JS start) to the first non-empty
//   thread list the app holds (`markListShown`).
//
// Each result goes to the Metro console as `[kybern timing] …` and into a small ring the dev kit
// shows (`app/dev-kit.tsx`, section "Load timings"). Release builds do nothing: no clock reads,
// no console output, no readout. See `perf/instant-load-2026-11.md`.
const enabled = () => typeof __DEV__ !== "undefined" && __DEV__;
const now = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
const started = now();

export interface Timing {
  kind: "thread" | "list";
  ms: number;
  detail: string;
  at: number;
}

const MAX = 30;
let ring: readonly Timing[] = [];
const taps = new Map<string, { at: number; cached: boolean }>();
const listeners = new Set<() => void>();
let listDone = false;

function record(timing: Omit<Timing, "at">) {
  const entry = { ...timing, at: Date.now() };
  ring = [entry, ...ring].slice(0, MAX);
  // eslint-disable-next-line no-console
  console.log(`[kybern timing] ${entry.kind} ${Math.round(entry.ms)} ms · ${entry.detail}`);
  listeners.forEach((fn) => fn());
}

/** A thread row was tapped. `cached`: a copy of the transcript is already on the phone. */
export function markThreadTap(threadId: string, cached = false) {
  if (!enabled()) return;
  taps.set(threadId, { at: now(), cached });
  if (taps.size > 20) taps.delete(taps.keys().next().value!);
}

/** The thread screen rendered transcript content. Only the first one after a tap counts. */
export function markThreadContent(threadId: string, rows: number) {
  if (!enabled()) return;
  const tap = taps.get(threadId);
  if (!tap) return;
  taps.delete(threadId);
  record({ kind: "thread", ms: now() - tap.at, detail: `${threadId.slice(0, 8)} · ${rows} rows${tap.cached ? " · cached" : ""}` });
}

/** The app holds a non-empty thread list. Only the first one after a cold start counts. */
export function markListShown(threads: number, source: "cache" | "daemon") {
  if (!enabled() || listDone || threads === 0) return;
  listDone = true;
  record({ kind: "list", ms: now() - started, detail: `${threads} threads from ${source === "cache" ? "the cache" : "the daemon"}` });
}

/** The recorded timings, newest first (the dev kit's readout). */
export function timings(): readonly Timing[] {
  return ring;
}

export function subscribeTimings(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
