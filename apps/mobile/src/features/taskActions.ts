import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { Alert } from "../ui/Alert";
import {
  deleteTask,
  setTaskPriority,
  setTaskStatus,
} from "../state/tasks";
import {
  PRIORITY_LABEL,
  PRIORITY_MENU_ORDER,
  STATUS_LABEL,
  USER_STATUSES,
  latestRun,
  taskTitle,
} from "../state/tasksModel";
import type { TaskItem, TaskPriority, TaskStatus } from "../state/protocol";
import { errorText } from "../state/runtime";

function fail(e: unknown) {
  Alert.alert("Unable to update the task", errorText(e), [{ text: "OK" }]);
}
/** Run an action and tell the reader what to do if it fails. */
export function attempt(work: () => Promise<unknown>, after?: () => void) {
  void work().then(() => after?.(), fail);
}

export function openTask(id: string) {
  router.push({ pathname: "/todo-item", params: { id } });
}
export function openSend(id: string) {
  router.push({ pathname: "/todo-send", params: { id } });
}
export function openThread(id: string) {
  router.push({ pathname: "/thread/[id]", params: { id } });
}

export function changeStatus(task: Pick<TaskItem, "id">, status: TaskStatus) {
  void Haptics.selectionAsync();
  attempt(() => setTaskStatus(task.id, status));
}
export function changePriority(
  task: Pick<TaskItem, "id">,
  priority: TaskPriority,
) {
  void Haptics.selectionAsync();
  attempt(() => setTaskPriority(task.id, priority));
}

const statusVerb: Record<TaskStatus, string> = {
  inbox: "Move to Inbox",
  todo: "Move to To do",
  running: "Running",
  needs_review: "Needs review",
  done: "Mark done",
  canceled: "Cancel task",
};

export function statusMenu(task: TaskItem) {
  Alert.alert(`${task.key} status`, `Now ${STATUS_LABEL[task.status]}`, [
    ...USER_STATUSES.filter((s) => s !== task.status).map((status) => ({
      text: statusVerb[status],
      onPress: () => changeStatus(task, status),
    })),
    { text: "Cancel", style: "cancel" as const },
  ]);
}

export function priorityMenu(task: TaskItem) {
  Alert.alert(`${task.key} priority`, `Now ${PRIORITY_LABEL[task.priority]}`, [
    ...PRIORITY_MENU_ORDER.filter((p) => p !== task.priority).map(
      (priority) => ({
        text: PRIORITY_LABEL[priority],
        onPress: () => changePriority(task, priority),
      }),
    ),
    { text: "Cancel", style: "cancel" as const },
  ]);
}

/** The menu behind a task's long-press and its "…" button. */
export function taskMenu(
  task: TaskItem,
  options: { afterDelete?: () => void } = {},
) {
  const run = latestRun(task);
  Alert.alert(`${task.key} · ${taskTitle(task)}`, undefined, [
    ...(task.status !== "done"
      ? [{ text: "Mark done", onPress: () => changeStatus(task, "done") }]
      : [{ text: "Move to To do", onPress: () => changeStatus(task, "todo") }]),
    { text: "Change status…", onPress: () => statusMenu(task) },
    { text: "Change priority…", onPress: () => priorityMenu(task) },
    run
      ? { text: `Open run ${run.number}`, onPress: () => openThread(run.thread_id) }
      : { text: "Send to agent…", onPress: () => openSend(task.id) },
    {
      text: "Delete task",
      style: "destructive" as const,
      onPress: () => attempt(() => deleteTask(task.id), options.afterDelete),
    },
    { text: "Cancel", style: "cancel" as const },
  ]);
}
