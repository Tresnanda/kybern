import { router } from "expo-router";
import { useMemo } from "react";
import { moveBanner } from "../../../../packages/kybern-client/src/continueOn";
import { isSubagentThread } from "../../../../packages/kybern-client/src/subagents";
import { machineParity } from "../state/machineActions";
import { machineHub, useMachineView } from "../state/runtime";
import { offersMachineMoves, threadMachineModel } from "../state/threadMachineModel";
import type { Thread } from "../state/protocol";
import { errorText, mutate, rpc } from "../state/runtime";
import { failedToast } from "../ui/failedToast";
import type { MenuItem } from "../ui/menuModel";
import { showToast } from "../ui/Toast";

/** Archive a thread, then "Thread archived · Undo" for five seconds. Rejects when the archive failed. */
export async function archiveThread(threadId: string) {
  await mutate("threads.archive", { thread_id: threadId });
  showArchivedToast(threadId);
}

/** "Thread archived · Undo": Undo brings the thread back. */
export function showArchivedToast(threadId: string) {
  showToast("Thread archived", { title: "Undo", icon: "arrow.uturn.backward", onPress: () => void unarchiveThread(threadId) }, 5000);
}

/** Bring an archived thread back as idle. A failure is a toast with Try again; resolves false then. */
export async function unarchiveThread(threadId: string): Promise<boolean> {
  try {
    await mutate("threads.unarchive", { thread_id: threadId });
    return true;
  } catch (e) {
    failedToast(e, "unarchive the thread", { params: { thread_id: threadId }, retry: () => void unarchiveThread(threadId) });
    return false;
  }
}

/** The actions behind a thread row's long-press (Threads list, iPad sidebar). */
export function threadMenuItems(
  thread: Thread,
  options: {
    refresh: () => unknown;
    onError?: (message: string) => void;
    /** The computer groups inactive threads in Older (a 0.25 daemon), so "Never move to Older" means something. */
    older?: boolean;
  },
): MenuItem[] {
  const fail = (e: unknown) => options.onError?.(errorText(e, "change the thread"));
  const update = (patch: { pinned?: boolean; keep_out_of_older?: boolean; move_out_of_older?: boolean }) => {
    void rpc("threads.update", { thread_id: thread.id, ...patch })
      .then(options.refresh)
      .catch(fail);
  };
  const archived = thread.status === "archived";
  const items: MenuItem[] = [
    {
      title: thread.pinned ? "Unpin thread" : "Pin thread",
      icon: thread.pinned ? "pin.fill" : "pin",
      onPress: () => update({ pinned: !thread.pinned }),
    },
  ];
  if (!archived && thread.older_at)
    items.push({ title: "Move out of Older", icon: "arrow.up", onPress: () => update({ move_out_of_older: true }) });
  if (!archived && thread.keep_out_of_older)
    items.push({ title: "Allow moving to Older", icon: "clock", onPress: () => update({ keep_out_of_older: false }) });
  else if (!archived && options.older && !thread.pinned)
    items.push({ title: "Never move to Older", icon: "clock.badge.xmark", onPress: () => update({ keep_out_of_older: true }) });
  items.push(
    archived
      ? { title: "Unarchive thread", icon: "tray.and.arrow.up", onPress: () => void unarchiveThread(thread.id) }
      : { title: "Archive thread", icon: "archivebox", onPress: () => void archiveThread(thread.id).catch(fail) },
  );
  return items;
}

// ---- ADE-99: moving a thread to another machine ----
/**
 * "Fork to another machine…" and "Continue on another machine…" for the thread menu. Empty with one machine, for a free chat or a
 * subagent, while the thread is moving, and when the thread's machine runs a version older than the gate (hidden, not disabled).
 */
export function useThreadMachineItems(thread: Thread | null | undefined): MenuItem[] {
  const view = useMachineView();
  return useMemo(() => {
    if (!thread || isSubagentThread(thread) || moveBanner(thread)) return [];
    const machine = machineHub().machineOfThread(thread.id);
    if (!machine || !machineParity(machine)) return [];
    const model = threadMachineModel({ machines: view.machines, projects: view.projects, threadMachine: machine, projectId: thread.project_id, gate: machineParity });
    if (!offersMachineMoves(model, view.machines.length)) return [];
    const open = (mode: "fork" | "move") => router.push({ pathname: "/fork-machine", params: { threadId: thread.id, mode } });
    return [
      { title: "Fork to another machine…", icon: "arrow.triangle.branch" as const, onPress: () => open("fork") },
      { title: "Continue on another machine…", icon: "arrow.triangle.swap" as const, onPress: () => open("move") },
    ];
  }, [thread, view]);
}
