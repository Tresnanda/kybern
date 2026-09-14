import type { Thread, ThreadReferencePart } from "./types.ts";

type ReferencedThread = Pick<Thread, "id" | "title" | "project_id">;

/** A picker selection retains its identity independently of the visible title. */
export interface ComposerThreadReference {
  token: string;
  part: ThreadReferencePart;
}

export function threadReferenceLabel(reference: Pick<ThreadReferencePart, "title">): string {
  return reference.title.replace(/\s+/g, " ").trim() || "Untitled thread";
}

export function threadReferencePart(thread: ReferencedThread): ThreadReferencePart {
  return {
    type: "thread_reference",
    thread_id: thread.id,
    title: threadReferenceLabel(thread),
    project_id: thread.project_id,
  };
}

/** Display text only. The typed part carries the identifier on the wire. */
export function formatThreadReference(thread: Pick<Thread, "title">, projectName?: string): string {
  const label = threadReferenceLabel(thread);
  const project = projectName?.replace(/\s+/g, " ").trim();
  return `@${JSON.stringify(project ? `${label} · ${project}` : label)}`;
}

/** Avoid silently retargeting a selected token when two threads share a title. */
export function createComposerThreadReference(
  thread: ReferencedThread,
  existing: readonly ComposerThreadReference[],
  projectName?: string,
): ComposerThreadReference {
  const previous = existing.find((reference) => reference.part.thread_id === thread.id);
  if (previous) return previous;
  const used = new Set(existing.map((reference) => reference.token));
  let token = formatThreadReference(thread);
  if (used.has(token)) token = formatThreadReference(thread, projectName);
  const label = threadReferenceLabel(thread);
  let index = 2;
  while (used.has(token)) token = formatThreadReference({ title: `${label} (${index++})` }, projectName);
  return { token, part: threadReferencePart(thread) };
}
