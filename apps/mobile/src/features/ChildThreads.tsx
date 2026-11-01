import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { mergeChildren, remoteChildrenOf } from "../machines/remoteChildren";
import type { Thread } from "../state/protocol";
import { childIsRunning, sortChildren } from "../state/orchestration";
import { machineHub, rpc, useApp, useMachineView } from "../state/runtime";

const POLL_MS = 5000;

/**
 * Threads this one started: delegated agents and subagents. They are left out of
 * the library, so the Agents sheet is how you reach them. A child's own progress
 * does not reach this thread's events, so the list reloads when the parent moves
 * and polls while anything runs. A thread on another machine is read from that machine
 * (and follows its `threads.changed`); a child another machine started under it joins from the
 * merged lists and opens on its own machine.
 */
export function useChildThreads(thread?: Thread | null, active = true): Thread[] {
  const app = useApp();
  const [children, setChildren] = useState<Thread[]>([]);
  const generation = useRef(0);
  const id = thread?.id;
  const view = useMachineView();
  // The machine that owns the thread: `threads.list` takes a parent id, which does not name a machine by itself.
  const owner = id && view.machines.length > 1 ? machineHub().machineOfThread(id) : undefined;
  const connected = app.status === "open";
  const load = useCallback(async () => {
    if (!id || !connected) return;
    const current = ++generation.current;
    try {
      const result = await rpc(
        "threads.list",
        { parent_thread_id: id, include_archived: true },
        owner,
      );
      if (current === generation.current) setChildren(sortChildren(result.threads));
    } catch {
      // Keep the last list; the next change or poll retries.
    }
  }, [id, connected, owner]);
  useEffect(() => {
    setChildren([]);
  }, [id]);
  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [load, thread?.last_seq, thread?.status]);
  // A thread on another machine: that machine's list changes reach the phone as `threads.changed`.
  useEffect(() => {
    if (!active || !id || !owner || owner === machineHub().primaryMachineId) return;
    try {
      return machineHub().set.handleFor(owner).onNotification("threads.changed", () => void load());
    } catch {
      return;
    }
  }, [active, id, owner, load]);
  const remote = useMemo(
    () => (id && owner ? remoteChildrenOf(view.threads.all, owner, id) : []),
    [view, id, owner],
  );
  const all = useMemo(() => mergeChildren(children, remote), [children, remote]);
  const running = all.some(childIsRunning);
  useEffect(() => {
    if (!active || (!running && thread?.status !== "running")) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [active, running, thread?.status, load]);
  return all;
}
