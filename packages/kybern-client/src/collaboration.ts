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
