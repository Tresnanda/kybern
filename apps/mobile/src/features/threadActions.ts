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
