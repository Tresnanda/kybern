import { dismissToast, restoreTask, useTasks } from "../state/tasks";
import { Toast } from "../ui/Toast";
import { attempt, openThread } from "./taskActions";

/** "ADE-14 started · Open" or "ADE-14 deleted · Undo", above the home indicator. */
export function TaskToast() {
  const { toast } = useTasks();
  if (!toast) return null;
  const action = toast.action;
  return (
    <Toast
      key={toast.id}
      text={toast.text}
      onDismiss={dismissToast}
      action={
        action?.kind === "undo"
          ? {
              title: "Undo",
              icon: "arrow.uturn.backward",
              onPress: () => attempt(() => restoreTask(action.taskId), dismissToast),
            }
          : action?.kind === "open"
            ? {
                title: "Open",
                onPress: () => {
                  dismissToast();
                  openThread(action.threadId);
                },
              }
            : undefined
      }
    />
  );
}
