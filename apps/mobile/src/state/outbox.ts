// Sends that wait in the outbox for a machine that is away (design §6.1, §6.4), on the phone. The phone queues through the
// computer it is at, or the nearest live member; that member's outbox says when the machine took the work. Until then a new
// thread shows "Waiting for satyamas" and a follow-up keeps its bubble with the same words.
import { isComposerOutbox, outboxThreadId, queuedPhase } from "../../../../packages/kybern-client/src/pendingSends";
import { optimisticThread, titleFromMessage, type QueuedCreate } from "../../../../packages/kybern-client/src/newChat";
import { queuedCreate } from "../../../../packages/kybern-client/src/machineTarget";
import type { KybernClient } from "../../../../packages/kybern-client/src/client";
import type { MachineId, OutboxItem, ThreadId, ThreadsCreateParams, ThreadsSendParams } from "../../../../packages/kybern-client/src/types";
import { pendingSends } from "./pendingSends";
import { currentClient, loadThread, machineHub, newChats, onClientAttach, refresh } from "./runtime";

/** A machine's name as the screens say it ("Waiting for satyamas"). */
export const machineName = (machineId: MachineId | undefined): string =>
  (machineId ? machineHub().set.connection(machineId)?.record.name : undefined) ?? "that machine";

const sends = new Map<string, { threadId: ThreadId; sendId: string; machineId: MachineId }>();
const watched = new WeakSet<KybernClient>();

function member(): KybernClient {
  const client = machineHub().memberClient();
  if (!client) throw new Error("Connect to a computer on your network first. Sends to an away machine wait there.");
  return client;
}

/** Follow a member's outbox: live changes, and (once) what is waiting there now. */
export function watchOutbox(client: KybernClient) {
  if (watched.has(client)) return;
  watched.add(client);
  client.onNotification("outbox.changed", (params) => {
    if (params) apply(params as OutboxItem);
  });
  void client
    .call("outbox.list", {})
    .then(({ items }) => {
      for (const item of items) {
        if (item.state === "queued" || item.state === "sending") restore(item);
        apply(item);
      }
    })
    .catch(() => {});
}

function apply(item: OutboxItem) {
  if (!isComposerOutbox(item)) return;
  const chat = newChats.outbox(item);
  if (chat?.state === "created") {
    // The machine has the thread now: read its list, then the thread, which opens as the real one.
    void refresh(chat.machineId).catch(() => {}).then(() => loadThread(chat.threadId)).catch(() => {});
  }
  const follow = sends.get(item.id);
  if (!follow) return;
  const phase = queuedPhase(item, machineName(follow.machineId));
  if (phase.phase === "delivered") {
    sends.delete(item.id);
    pendingSends.update(follow.threadId, follow.sendId, { state: "accepted" });
    void loadThread(follow.threadId).catch(() => {});
  } else if (phase.phase === "failed") {
    sends.delete(item.id);
    pendingSends.update(follow.threadId, follow.sendId, { state: "failed", error: phase.error });
  }
}

/** Queue a new thread for a machine that is away. The caller's chat waits on the returned marker. */
export async function queueNewChat(machineId: MachineId, params: ThreadsCreateParams & { thread_id: string }): Promise<QueuedCreate> {
  const client = member();
  watchOutbox(client);
  const item = await client.call("outbox.enqueue", { target: machineId, operation: queuedCreate(params) });
  return { queued: { outboxId: item.id } };
}

/** Queue a follow-up to a thread on a machine that is away. */
export async function queueSend(machineId: MachineId, params: ThreadsSendParams & { message_id: string }): Promise<void> {
  const client = member();
  watchOutbox(client);
  const item = await client.call("outbox.enqueue", { target: machineId, operation: { kind: "thread_send", payload: params } });
  sends.set(item.id, { threadId: params.thread_id, sendId: params.message_id, machineId });
  pendingSends.update(params.thread_id, params.message_id, { state: "waiting", machineId });
}

/** A chat still waiting from before the app started: shown again with its first message. */
function restore(item: OutboxItem) {
  const params = item.payload as ThreadsCreateParams | null;
  const threadId = outboxThreadId(item);
  if (item.kind !== "thread_create" || !params?.message || !params.message_id || !threadId || newChats.get(threadId)) return;
  const view = machineHub().view();
  const logical = params.project_id
    ? view.projects.find((p) => p.instances.some((i) => i.machineId === item.target && i.project.id === params.project_id))
    : undefined;
  const here = view.machines.find((m) => m.isLocal)?.machineId;
  const projectId = logical ? logical.instances.find((i) => i.machineId === here)?.project.id ?? logical.primary.project.id : (params.project_id ?? "");
  const thread = {
    ...optimisticThread({ id: threadId, projectId, provider: params.provider, model: params.model ?? null, effort: params.effort ?? null, permissionMode: params.permission_mode ?? "supervised", message: params.message, now: new Date(item.created_at) }),
    title: params.title ?? titleFromMessage(params.message),
  };
  newChats.restore(
    { threadId, messageId: params.message_id, message: params.message, worktree: !!params.use_worktree, thread, machineId: item.target, machineName: machineName(item.target), outboxId: item.id },
    (first, messageId) => queueNewChat(item.target, { ...params, message: first, message_id: messageId, thread_id: threadId }),
  );
}

// Every computer the phone connects to: its outbox is followed from then on.
onClientAttach((client) => watchOutbox(client));
const attached = currentClient();
if (attached) watchOutbox(attached);

// ---- the Machines screen's view of every outbox (ADE-99 §2.1) ----
import { liveMachines } from "./machineActions";

/** Each live machine's outbox (the phone queues through one member, but other members hold their own sends). */
export async function listOutboxes(): Promise<{ holder: MachineId; items: OutboxItem[] }[]> {
  const live = liveMachines();
  const results = await Promise.allSettled(live.map((c) => machineHub().clientFor(c.record.machineId).call("outbox.list", {})));
  return results.flatMap((result, index) =>
    result.status === "fulfilled" ? [{ holder: live[index]!.record.machineId, items: result.value.items }] : [],
  );
}
export async function retryOutboxItem(holder: MachineId, id: string): Promise<void> {
  await machineHub().clientFor(holder).call("outbox.retry", { id });
}
export async function cancelOutboxItem(holder: MachineId, id: string): Promise<void> {
  await machineHub().clientFor(holder).call("outbox.cancel", { id });
}
/** Calls `fn` when any live machine's outbox changes. Returns the unsubscribe. */
export function onOutboxesChanged(fn: () => void): () => void {
  const stops = liveMachines().map((c) => machineHub().clientFor(c.record.machineId).onNotification("outbox.changed", fn));
  return () => stops.forEach((stop) => stop());
}
