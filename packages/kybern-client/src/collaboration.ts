import type { ThreadEvent } from "./types.ts";

/** Resolve a collaboration event without making transcript rows depend on it. */
export function collaborationEventGroupId(event: ThreadEvent): string | null {
  switch (event.kind) {
    case "collaboration_group_updated":
      return event.group.id;
    case "collaboration_member_updated":
      return event.member.group_id;
    case "collaboration_assignment_updated":
      return event.assignment.group_id;
    case "collaboration_message_updated":
      return event.message.group_id;
    case "collaboration_context_updated":
      return event.entry.group_id;
    default:
      return null;
  }
}

export function shouldReloadCollaboration(
  event: ThreadEvent | null,
  currentGroupId?: string | null,
): boolean {
  if (event === null || !currentGroupId) return true;
  return collaborationEventGroupId(event) === currentGroupId;
}

/** Presentation only: recognizes the legacy daemon envelope, never grants authority. */
export function collaborationPreview(text: string): { purpose: string; senderId: string | null; body: string } | null {
  const match = /^Kybern collaboration (Result|Reply|Question|ChangeRequest|Progress|Failure|Redirect) from (?:thread ([0-9a-f-]{36})|the user) \(message [0-9a-f-]{36}, reply_to (?:None|Some\([0-9a-f-]{36}\))\):\n([\s\S]*)$/.exec(text);
  if (!match) return null;
  const body = match[3]!.replace(/\n\n(?:Do not send an acknowledgement wakeup\. Continue only if this message gives you actual work; otherwise record progress without waking the sender\.|Respond with kybern_collaboration_send and set reply_to to this message id\.)$/, "");
  return { purpose: match[1] === "ChangeRequest" ? "Change request" : match[1]!, senderId: match[2] ?? null, body };
}

/** Collapsed branches never reappear as orphan roots; cycles remain reachable. */
export function collaborationThreadRows<T extends { id: string; parent_thread_id?: string | null }>(
  threads: readonly T[], expanded: Readonly<Record<string, boolean>>, activeId?: string,
): { thread: T; depth: number; childCount: number; open: boolean }[] {
  const byId = new Map(threads.map(thread => [thread.id, thread]));
  const children = new Map<string, T[]>();
  for (const thread of threads) {
    if (!thread.parent_thread_id || !byId.has(thread.parent_thread_id) || thread.parent_thread_id === thread.id) continue;
    const list = children.get(thread.parent_thread_id) ?? [];
    list.push(thread);
    children.set(thread.parent_thread_id, list);
  }
  const ancestors = new Set<string>();
  let parent = activeId ? byId.get(activeId)?.parent_thread_id : null;
  while (parent && !ancestors.has(parent)) {
    ancestors.add(parent);
    parent = byId.get(parent)?.parent_thread_id;
  }
  const rows: { thread: T; depth: number; childCount: number; open: boolean }[] = [];
  const visited = new Set<string>();
  const append = (thread: T, depth: number, visible: boolean) => {
    if (visited.has(thread.id)) return;
    visited.add(thread.id);
    const nested = children.get(thread.id) ?? [];
    const open = expanded[thread.id] ?? ancestors.has(thread.id);
    if (visible) rows.push({ thread, depth, childCount: nested.length, open });
    for (const child of nested) append(child, depth + 1, visible && open);
  };
  for (const thread of threads) {
    if (!thread.parent_thread_id || !byId.has(thread.parent_thread_id) || thread.parent_thread_id === thread.id) append(thread, 0, true);
  }
  for (const thread of threads) if (!visited.has(thread.id)) append(thread, 0, true);
  return rows;
}
