import { useCallback, useEffect, useRef, useState } from "react";
import type { Thread } from "../state/protocol";
import { childIsRunning, sortChildren } from "../state/orchestration";
import { rpc, useApp } from "../state/runtime";

const POLL_MS = 5000;

/**
 * Threads this one started: delegated agents and subagents. They are left out of
 * the library, so the Agents sheet is how you reach them. A child's own progress
 * does not reach this thread's events, so the list reloads when the parent moves
 * and polls while anything runs.
 */
export function useChildThreads(thread?: Thread | null, active = true): Thread[] {
  const app = useApp();
  const [children, setChildren] = useState<Thread[]>([]);
  const generation = useRef(0);
  const id = thread?.id;
  const connected = app.status === "open";
  const load = useCallback(async () => {
    if (!id || !connected) return;
    const current = ++generation.current;
    try {
      const result = await rpc("threads.list", {
        parent_thread_id: id,
        include_archived: true,
      });
      if (current === generation.current) setChildren(sortChildren(result.threads));
    } catch {
      // Keep the last list; the next change or poll retries.
    }
  }, [id, connected]);
  useEffect(() => {
    setChildren([]);
  }, [id]);
  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [load, thread?.last_seq, thread?.status]);
  const running = children.some(childIsRunning);
  useEffect(() => {
    if (!active || (!running && thread?.status !== "running")) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [active, running, thread?.status, load]);
  return children;
}
