// A Coordinator's project space, as both clients show it: the project's brief and
// setup notes (one of each, marked by `project_role`) and its memory, every other
// live project note. The copy lives here so desktop and mobile say the same thing.
import type { NoteSummary, ProjectId } from "./types.ts";

/** Title the brief note gets when a client creates it. */
export const BRIEF_NOTE_TITLE = "Project brief";

export const PROJECT_SPACE_COPY = {
  briefOwner: "Only you can change the brief. Agents suggest edits in chat.",
  briefEmpty: "Describe the project and how you like work done. The Coordinator and its agents read it first.",
  briefPlaceholder: "What the project is, what matters, and how you like work done",
  briefSaveFailed: "Unable to save the brief. Check the connection and try again.",
  setupEmpty: "The Coordinator writes this on its first research pass: how to build, run and test the project.",
  memoryEmpty: "Agents save what they learn here, like how to run a service or how you like work done.",
  switchTitle: "Give every thread in this project the brief",
  switchDetail: "New threads only. The Coordinator and its agents always get it.",
  switchFailed: "Unable to change the setting. Check the connection and try again.",
} as const;

export interface ProjectSpaceNotes {
  brief: NoteSummary | null;
  setup: NoteSummary | null;
  /** The project's other notes, newest first. */
  memory: NoteSummary[];
}

const newestFirst = (a: NoteSummary, b: NoteSummary) => b.updated_at.localeCompare(a.updated_at);

/** Split a note list into the project's brief, setup note and memory. Deleted notes and thread notes are left out. */
export function projectSpaceNotes(notes: readonly NoteSummary[], projectId: ProjectId): ProjectSpaceNotes {
  let brief: NoteSummary | null = null;
  let setup: NoteSummary | null = null;
  const memory: NoteSummary[] = [];
  for (const note of notes) {
    if (note.deleted_at || note.scope !== "project" || note.project_id !== projectId) continue;
    if (note.project_role === "brief") {
      if (!brief || newestFirst(note, brief) < 0) brief = note;
    } else if (note.project_role === "setup") {
      if (!setup || newestFirst(note, setup) < 0) setup = note;
    } else memory.push(note);
  }
  memory.sort(newestFirst);
  return { brief, setup, memory };
}

/** One line of a note's plain-text preview, for a two-line row. */
export function notePreviewLine(note: Pick<NoteSummary, "preview">): string {
  return note.preview.replace(/\s+/g, " ").trim();
}
