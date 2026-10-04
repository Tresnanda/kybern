// Pure note logic: ordering, change folding, search, and grouping for the list.
// Keep this file free of React and native imports so it stays unit-testable.
import type { NoteSummary, Project } from "./protocol";

/** Matches RpcError CONFLICT from the daemon. */
export const NOTES_CONFLICT = -32004;
export const METHOD_NOT_FOUND = -32601;
export const AUTOSAVE_MS = 600;
export const UNDO_MS = 6000;

export const noteTitle = (note: Pick<NoteSummary, "title">) =>
  note.title.trim() || "Untitled";

/** "3/7" for notes with checklist items, otherwise nothing. */
export function checklistBadge(note: Pick<NoteSummary, "checklist">) {
  const { done, total } = note.checklist ?? { done: 0, total: 0 };
  return total > 0 ? `${done}/${total}` : "";
}

/** Pinned first, then most recently edited. */
export function sortNotes(notes: NoteSummary[]) {
  return [...notes].sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      b.updated_at.localeCompare(a.updated_at),
  );
}

/** Fold one `notes.changed` notification into the list. */
export function applyNoteChange(
  notes: NoteSummary[],
  change: { note?: NoteSummary | null; purged_id?: string | null },
) {
  if (change.purged_id)
    return notes.filter((note) => note.id !== change.purged_id);
  const next = change.note;
  if (!next) return notes;
  const index = notes.findIndex((note) => note.id === next.id);
  // Never replace a newer row with an older notification that arrived late.
  if (index >= 0 && notes[index]!.revision > next.revision) return notes;
  const rest = index >= 0 ? notes.filter((_, i) => i !== index) : notes;
  return sortNotes([...rest, next]);
}

export interface SearchHit {
  id: string;
  snippet: string;
}

/**
 * Titles and previews match instantly on the phone; the daemon's body search
 * adds notes whose match is further down. A body hit shows its snippet.
 */
export function filterNotes(
  notes: NoteSummary[],
  query: string,
  hits: SearchHit[] = [],
) {
  const needle = query.trim().toLowerCase();
  if (!needle) return { notes, snippets: new Map<string, string>() };
  const snippets = new Map(hits.map((hit) => [hit.id, hit.snippet]));
  const matched = notes.filter(
    (note) =>
      note.title.toLowerCase().includes(needle) ||
      note.preview.toLowerCase().includes(needle) ||
      (!note.deleted_at && snippets.has(note.id)),
  );
  // A title or preview match reads better than a body snippet of the same note.
  for (const note of matched)
    if (
      note.title.toLowerCase().includes(needle) ||
      note.preview.toLowerCase().includes(needle)
    )
      snippets.delete(note.id);
  return { notes: matched, snippets };
}

export interface ProjectNotes {
  projectId: string;
  name: string;
  notes: NoteSummary[];
  threadNotes: NoteSummary[];
}
export interface NoteGroups {
  pinned: NoteSummary[];
  global: NoteSummary[];
  projects: ProjectNotes[];
  chats: NoteSummary[];
  deleted: NoteSummary[];
}

/**
 * Sections for the list: Pinned, Global, one per project (project notes, then
 * thread notes), Chats, then Recently deleted. A pinned note appears once, in
 * Pinned. Input order (pinned, then newest) is preserved inside each section.
 */
export function groupNotes(
  notes: NoteSummary[],
  projects: Pick<Project, "id" | "name">[],
  isFreeChat: (projectId: string) => boolean,
): NoteGroups {
  const groups: NoteGroups = {
    pinned: [],
    global: [],
    projects: [],
    chats: [],
    deleted: [],
  };
  const byProject = new Map<string, ProjectNotes>();
  const section = (note: NoteSummary) => {
    const id = note.project_id ?? "";
    let entry = byProject.get(id);
    if (!entry) {
      entry = {
        projectId: id,
        name: projects.find((p) => p.id === id)?.name ?? "Project",
        notes: [],
        threadNotes: [],
      };
      byProject.set(id, entry);
    }
    return entry;
  };
  for (const note of notes) {
    if (note.deleted_at) groups.deleted.push(note);
    else if (note.pinned) groups.pinned.push(note);
    else if (note.scope === "global") groups.global.push(note);
    else if (note.scope === "project") section(note).notes.push(note);
    else if (note.project_id && isFreeChat(note.project_id))
      groups.chats.push(note);
    else section(note).threadNotes.push(note);
  }
  groups.deleted.sort((a, b) =>
    (b.deleted_at ?? "").localeCompare(a.deleted_at ?? ""),
  );
  groups.projects = [...byProject.values()].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
  return groups;
}

export type NoteSaveStatus =
  | "idle"
  | "dirty"
  | "saving"
  | "saved"
  | "error"
  | "conflict";

export function saveStatusText(status: NoteSaveStatus) {
  switch (status) {
    case "dirty":
    case "saving":
      return "Saving…";
    case "saved":
      return "Saved";
    case "error":
      return "Not saved";
    case "conflict":
      return "Not saved";
    default:
      return "";
  }
}

/** Markdown for Copy and Share: the title becomes a heading. */
export function noteMarkdown(title: string, body: string) {
  const heading = title.trim();
  return heading ? `# ${heading}\n\n${body}`.trimEnd() + "\n" : body;
}

/** Deleted notes stay for 30 days; after that the daemon removes them. */
export const RETENTION_DAYS = 30;
export function daysLeft(deletedAt: string, now = Date.now()) {
  const left =
    RETENTION_DAYS - Math.floor((now - Date.parse(deletedAt)) / 86_400_000);
  return Math.max(0, left);
}
