import { router } from "expo-router";
import { Alert } from "../ui/Alert";
import { haptics } from "../ui/haptics";
import type { MenuItem } from "../ui/menuModel";
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
  haptics.select();
  attempt(() => setTaskStatus(task.id, status));
}
export function changePriority(
  task: Pick<TaskItem, "id">,
  priority: TaskPriority,
) {
  haptics.select();
  attempt(() => setTaskPriority(task.id, priority));
}

/** Status choices with the current one checked (a submenu, or a property row's menu). */
export function statusMenuItems(task: TaskItem): MenuItem[] {
  return USER_STATUSES.map((status) => ({
    title: STATUS_LABEL[status],
    checked: status === task.status,
    onPress: () => {
      if (status !== task.status) changeStatus(task, status);
    },
  }));
}

/** Priority choices with the current one checked. */
export function priorityMenuItems(task: TaskItem): MenuItem[] {
  return PRIORITY_MENU_ORDER.map((priority) => ({
    title: PRIORITY_LABEL[priority],
    checked: priority === task.priority,
    onPress: () => {
      if (priority !== task.priority) changePriority(task, priority);
    },
  }));
}

/** The actions behind a task's long-press and its "…" button. */
export function taskMenuItems(
  task: TaskItem,
  options: { afterDelete?: () => void } = {},
): MenuItem[] {
  const run = latestRun(task);
  return [
    task.status !== "done"
      ? { title: "Mark done", icon: "checkmark.circle", onPress: () => changeStatus(task, "done") }
      : { title: "Move to To do", icon: "circle", onPress: () => changeStatus(task, "todo") },
    { title: "Status", icon: "circle.lefthalf.filled", children: statusMenuItems(task) },
    { title: "Priority", icon: "chart.bar", children: priorityMenuItems(task) },
    run
      ? { title: `Open run ${run.number}`, icon: "text.bubble", onPress: () => openThread(run.thread_id) }
      : { title: "Send to agent…", icon: "paperplane", onPress: () => openSend(task.id) },
    {
      title: "Delete task",
      icon: "trash",
      destructive: true,
      onPress: () => attempt(() => deleteTask(task.id), options.afterDelete),
    },
  ];
}
