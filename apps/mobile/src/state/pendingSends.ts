// A follow-up that failed to send stays in the conversation as a failed bubble with Retry and
// Edit (P1-17), the way a failed new chat does. One store per app over the shared model
// (`packages/kybern-client/src/pendingSends.ts`); the real user block replaces the pending one by
// id, since the send passes the pending id as `message_id`.
import { randomUUID } from "expo-crypto";
import { useCallback, useSyncExternalStore } from "react";
import { createPendingStore, settledPending, withPending, type PendingSend } from "../../../../packages/kybern-client/src/pendingSends";
import type { Block } from "./transcript";
import type { UserMessage } from "./protocol";
import { OfflineError } from "../../../../packages/kybern-client/src/machines";
import { queueSend } from "./outbox";
import { errorText, loadThread, machineHub, rpc } from "./runtime";

export const pendingSends = createPendingStore();
export { withPending, settledPending };

export function usePendingSends(threadId: string) {
  const read = useCallback(() => pendingSends.pendingFor(threadId), [threadId]);
  return useSyncExternalStore(pendingSends.subscribe, read, read);
}

export function usePendingSend(threadId: string, id: string): PendingSend | undefined {
  return usePendingSends(threadId).find((send) => send.id === id);
}

/** Drop pending sends whose real block arrived. Call from an effect, never during render. */
export function settlePending(threadId: string, blocks: readonly Block[]) {
  for (const id of settledPending(blocks, pendingSends.pendingFor(threadId))) pendingSends.remove(threadId, id);
}

/** `threads.send` that leaves a failed bubble instead of throwing. Resolves with the receipt, or null when it failed. */
export async function sendWithPending(threadId: string, message: UserMessage, existing?: string) {
  const id = existing ?? randomUUID();
  if (existing) pendingSends.update(threadId, id, { state: "sending", error: undefined });
  try {
    const receipt = await rpc("threads.send", { thread_id: threadId, message, message_id: id });
    if (existing) pendingSends.update(threadId, id, { state: "accepted" });
    void loadThread(threadId).catch(() => {});
    return receipt;
  } catch (e) {
    // The thread's machine is away: the message waits in the outbox and goes when the machine returns.
    const machine = e instanceof OfflineError ? machineHub().machineOfThread(threadId) : undefined;
    if (machine) {
      if (!existing) pendingSends.add({ id, threadId, message, at: new Date().toISOString(), delivery: "send", state: "sending" });
      try {
        await queueSend(machine, { thread_id: threadId, message, message_id: id });
        return null;
      } catch (queueError) {
        e = queueError;
      }
    }
    const error = errorText(e) || "Check the connection and try again.";
    if (existing) pendingSends.update(threadId, id, { state: "failed", error });
    else pendingSends.add({ id, threadId, message, at: new Date().toISOString(), delivery: "send", state: "failed", error });
    return null;
  }
}

export function retryPending(send: PendingSend) {
  return sendWithPending(send.threadId, send.message, send.id);
}

type EditListener = (message: UserMessage) => void;
const editors = new Map<string, EditListener>();
/** The thread screen takes an edited failed message back into its composer. */
export function onEditPending(threadId: string, listener: EditListener) {
  editors.set(threadId, listener);
  return () => {
    if (editors.get(threadId) === listener) editors.delete(threadId);
  };
}
export function editPending(send: PendingSend) {
  pendingSends.remove(send.threadId, send.id);
  editors.get(send.threadId)?.(send.message);
}
