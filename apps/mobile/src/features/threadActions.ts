import { router } from "expo-router";
import { useMemo } from "react";
import { moveBanner } from "../../../../packages/kybern-client/src/continueOn";
import { isSubagentThread } from "../../../../packages/kybern-client/src/subagents";
import { machineParity } from "../state/machineActions";
import { machineHub, useMachineView } from "../state/runtime";
import { offersMachineMoves, threadMachineModel } from "../state/threadMachineModel";
import type { Thread } from "../state/protocol";
import { errorText, rpc } from "../state/runtime";
import type { MenuItem } from "../ui/menuModel";
import { showToast } from "../ui/Toast";

/** The actions behind a thread row's long-press (Threads list, iPad sidebar). */
export function threadMenuItems(
  thread: Thread,
  options: { refresh: () => unknown; onError?: (message: string) => void },
): MenuItem[] {
  const fail = (e: unknown) => options.onError?.(errorText(e));
  return [
    {
      title: thread.pinned ? "Unpin thread" : "Pin thread",
      icon: thread.pinned ? "pin.fill" : "pin",
      onPress: () => {
        void rpc("threads.update", { thread_id: thread.id, pinned: !thread.pinned })
          .then(options.refresh)
          .catch(fail);
      },
    },
    ...(thread.status !== "archived"
      ? [
          {
            title: "Archive thread",
            icon: "archivebox" as const,
            onPress: () => {
              void rpc("threads.archive", { thread_id: thread.id })
                .then(() => {
                  showToast("Thread archived");
                  return options.refresh();
                })
                .catch(fail);
            },
          },
        ]
      : []),
  ];
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
