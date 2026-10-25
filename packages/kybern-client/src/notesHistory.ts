// How a client shows the Coordinator's notes as history and its project map: the section a
// note sits in, the quiet line under a stale or undated one, a retired claim, and the map's
// header and rows. Pure and locale-free, so every client words these the same way.
import type { NoteCategory, NoteSummary, ProjectMap, ProjectMapChange } from "./types.ts";

export type NoteGroupKey = NoteCategory | "other" | "undated";

/** The sections of a project's notes, in the order the Coordinator's index lists them. */
export const NOTE_GROUPS: readonly { key: NoteGroupKey; label: string }[] = [
  { key: "preference", label: "Preferences" },
  { key: "decision", label: "Decisions" },
  { key: "convention", label: "Conventions" },
  { key: "gotcha", label: "Gotchas" },
  { key: "other", label: "Other" },
  { key: "undated", label: "Undated" },
];

/** The category picker's choices, in the same order. A category can be set or changed, not cleared (`notes.update` ignores an absent one). */
export const NOTE_CATEGORIES: readonly { value: NoteCategory; label: string }[] = [
  { value: "preference", label: "Preference" },
  { value: "decision", label: "Decision" },
  { value: "convention", label: "Convention" },
  { value: "gotcha", label: "Gotcha" },
];

export const NOTES_HISTORY_COPY = {
  staleTitle: "May be outdated",
  categoryLabel: "Category",
  mapTab: "Map",
  mapEmptyTitle: "No map yet",
  mapEmptyBody: "The map appears once the project has a repository to read.",
  mapRebuild: "Rebuild map",
  mapLayout: "Layout",
  mapCommands: "Commands",
  mapBusy: "Busy areas",
  mapBusyMeta: "30 days",
  mapRemoved: "Removed and renamed",
  mapRemovedMeta: "14 days",
} as const;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** "Oct 26" from an ISO timestamp (read in the viewer's time zone) or a plain `YYYY-MM-DD` date. */
export function monthDay(value: string): string {
  const plain = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (plain) return `${MONTHS[Number(plain[2]) - 1] ?? ""} ${Number(plain[3])}`.trim();
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? "" : `${MONTHS[at.getMonth()]} ${at.getDate()}`;
}

/** The last path segment: "src/auth/session.ts" is "session.ts". */
export function fileName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** The section a note belongs in. */
export function noteGroupKey(note: Pick<NoteSummary, "category" | "undated">): NoteGroupKey {
  if (note.category) return note.category;
  return note.undated ? "undated" : "other";
}

/** `notes` split into the non-empty sections, in `NOTE_GROUPS` order; each keeps its notes' order. */
export function groupNotes<T extends Pick<NoteSummary, "category" | "undated">>(notes: readonly T[]): { key: NoteGroupKey; label: string; notes: T[] }[] {
  const by = new Map<NoteGroupKey, T[]>();
  for (const note of notes) {
    const key = noteGroupKey(note);
    const list = by.get(key);
    if (list) list.push(note);
    else by.set(key, [note]);
  }
  return NOTE_GROUPS.flatMap((group) => (by.has(group.key) ? [{ ...group, notes: by.get(group.key)! }] : []));
}

/** The line under a stale note's title: "May be outdated · session.ts changed". */
export function staleSnippet(stale: { path: string }): string {
  return `${NOTES_HISTORY_COPY.staleTitle} · ${fileName(stale.path)} changed`;
}

/** The line under an undated note's title: "Undated, before Oct 25". */
export function undatedSnippet(historySince?: string | null): string {
  const day = historySince ? monthDay(historySince) : "";
  return day ? `Undated, before ${day}` : "Undated";
}

/** A note row's second line: why it is flagged, else its preview. */
export function noteSnippet(note: Pick<NoteSummary, "stale" | "undated" | "category" | "preview">, historySince?: string | null): { kind: "stale" | "undated" | "preview"; text: string } {
  if (note.stale) return { kind: "stale", text: staleSnippet(note.stale) };
  if (!note.category && note.undated) return { kind: "undated", text: undatedSnippet(historySince) };
  return { kind: "preview", text: note.preview.replace(/\s+/g, " ").trim() };
}

const SUPERSEDED = /\(superseded (\d{4}-\d{2}-\d{2})\)\s*$/;

/** The date a retired claim carries: the text after `~~…~~` reads "(superseded 2026-10-25)". Null for any other text. */
export function supersededDate(trailing: string): string | null {
  return SUPERSEDED.exec(trailing)?.[1] ?? null;
}

/** "Superseded Oct 25", the quiet label beside a retired claim. */
export function supersededLabel(date: string): string {
  return `Superseded ${monthDay(date)}`.trim();
}

/** The lines of a note body that were retired, as `- ~~claim~~ (superseded 2026-10-25)`. */
export function supersededLines(body: string): { line: number; text: string; date: string }[] {
  const out: { line: number; text: string; date: string }[] = [];
  let fenced = false;
  body.split("\n").forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) return;
    const match = /^\s*(?:(?:[-*+]|\d+[.)])\s+)?~~(.+)~~\s*\(superseded (\d{4}-\d{2}-\d{2})\)\s*$/.exec(line);
    if (match) out.push({ line: index, text: match[1]!, date: match[2]! });
  });
  return out;
}

// ---- project map ----

/** The commit a map is stamped with: the primary repository's HEAD (the first one). */
export function mapHead(map: Pick<ProjectMap, "repos">): { repo: string; sha: string; branch: string | null } | null {
  const repo = map.repos[0];
  return repo ? { repo: repo.name, sha: repo.head.slice(0, 7), branch: repo.branch ?? repo.default_branch ?? null } : null;
}

/** "5 min ago" style age of the map's build; "just now" under a minute. */
export function builtAgo(builtAt: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - new Date(builtAt).getTime()) / 1000));
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

/** One line for a removed or renamed file: the status letter, what moved, and when. */
export function changeRow(change: ProjectMapChange): { status: "D" | "R"; path: string; commit: string; date: string } {
  return {
    status: change.kind === "renamed" ? "R" : "D",
    path: change.kind === "renamed" && change.from ? `${change.from} → ${change.path}` : change.path,
    commit: change.commit.slice(0, 7),
    date: monthDay(change.date),
  };
}
