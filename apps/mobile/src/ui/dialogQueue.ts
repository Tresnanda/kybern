export type DialogButton = {
  text?: string;
  style?: "default" | "cancel" | "destructive";
  onPress?: (value: string) => void;
};
export type DialogRequest = {
  title: string;
  message?: string;
  buttons: DialogButton[];
  prompt?: { defaultValue: string; secure: boolean };
  cancelable?: boolean;
  onDismiss?: () => void;
};

// Remove only after the exit finishes, and before calling an action. An action
// can enqueue another dialog without replacing or accidentally confirming it.
export function createDialogQueue() {
  let nextId = 0;
  let queue: (DialogRequest & { id: number })[] = [];
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((listener) => listener());
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => queue[0] ?? null,
    enqueue(request: DialogRequest) {
      queue = [...queue, { ...request, id: ++nextId }];
      emit();
    },
    finish(id: number, buttonIndex: number | null, value = "") {
      const request = queue[0];
      if (!request || request.id !== id) return;
      queue = queue.slice(1);
      emit();
      if (buttonIndex === null) request.onDismiss?.();
      else request.buttons[buttonIndex]?.onPress?.(value);
    },
  };
}
export const dialogQueue = createDialogQueue();
