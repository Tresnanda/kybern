// A message the transcript sends on the reader's behalf (a sign-in chip, "Reply in chat",
// "Change answer"): queued behind a running turn, otherwise sent as the next turn.
import { randomUUID } from "expo-crypto";
import { getState, loadThread, refresh, rpc } from "./runtime";

export async function sendFollowUp(threadId: string, text: string) {
  const thread = getState().threads.find((item) => item.id === threadId);
  const message = { parts: [{ type: "text" as const, text }] };
  if (thread?.status === "running" || thread?.status === "awaiting-approval") {
    await rpc("queue.add", { thread_id: threadId, id: randomUUID(), message });
    await refresh();
  } else {
    await rpc("threads.send", { thread_id: threadId, message });
    await loadThread(threadId);
  }
}
