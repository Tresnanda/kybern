// The composer's @ picker model: filter chips, typed `@note:` style prefixes and
// ranking for notes and tasks. Pure helpers, so ranking is testable without React.

import type { NoteId, NoteSummary, ProjectId, TaskItem } from "@/protocol"

export type MentionKind = "thread" | "note" | "task" | "file" | "plugin"
export type MentionFilter = "all" | MentionKind

/** Chip order, which is also the order of the sections under All. */
export const MENTION_KINDS: readonly MentionKind[] = ["thread", "note", "task", "file", "plugin"]

export const MENTION_FILTER_LABEL: Record<MentionFilter, string> = {
  all: "All",
  thread: "Threads",
  note: "Notes",
  task: "Tasks",
  file: "Files",
  plugin: "Plugins",
}

/** Results per kind under All; a chip shows its kind's full list. */
export const MENTION_ALL_PER_KIND = 3
export const MENTION_KIND_LIMIT = 20

const PREFIXES: Record<string, MentionKind> = {
  thread: "thread",
  threads: "thread",
  note: "note",
  notes: "note",
  task: "task",
  tasks: "task",
  file: "file",
  files: "file",
  plugin: "plugin",
  plugins: "plugin",
}

/** `note:login` → the Notes chip searching "login". Anything else searches every kind. */
export function parseMentionQuery(query: string): { kind: MentionKind | null; prefixLength: number; term: string } {
  const match = /^([a-z]+):/i.exec(query)
  const kind = match ? PREFIXES[match[1]!.toLowerCase()] : undefined
  return kind ? { kind, prefixLength: match![0].length, term: query.slice(match![0].length) } : { kind: null, prefixLength: 0, term: query }
}

/**
 * The `@` token the caret is in, or null. `@` must begin a token (start of text or
 * after whitespace), so an email like `a@b.com` never opens the picker.
 */
export function mentionAtCaret(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const at = before.lastIndexOf("@")
  if (at === -1) return null
  if (at > 0 && !/\s/.test(before[at - 1]!)) return null
  const query = before.slice(at + 1)
  if (/\s/.test(query)) return null
  return { start: at, query }
}

/**
 * ←/→ switch the picker's chips only before a search term is typed (`@` or `@task:`);
 * once there is a term they move the caret like anywhere else.
 */
export function mentionArrowsSwitchChips(query: string): boolean {
  return parseMentionQuery(query).term === ""
}

/** Lower is better; null is no match. Exact, prefix, word start, substring, then in-order letters. */
export function fuzzyScore(value: string, query: string): number | null {
  const haystack = value.toLowerCase()
  const needle = query.trim().toLowerCase()
  if (!needle) return 0
  if (haystack === needle) return 0
  if (haystack.startsWith(needle)) return 1
  const boundary = haystack.search(new RegExp(`(?:^|[\\s:_-])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`))
  if (boundary >= 0) return 2 + boundary / 100
  const included = haystack.indexOf(needle)
  if (included >= 0) return 4 + included / 100
  let at = 0
  for (const character of needle) {
    at = haystack.indexOf(character, at)
    if (at < 0) return null
    at += 1
  }
  return 10 + (haystack.length - needle.length) / 100
}

const isEmptyThreadNote = (note: NoteSummary) => note.scope === "thread" && !note.preview.trim() && note.checklist.total === 0

/**
 * Notes for the picker. Without a query: pinned, then this chat's project, then
 * recent. With one: title matches first, then preview and body matches (the
 * daemon's `notes.search` snippets in `bodyHits`).
 */
export function rankMentionNotes(
  notes: readonly NoteSummary[],
  term: string,
  bodyHits: ReadonlyMap<NoteId, string> | null,
  projectId: ProjectId | null | undefined,
  limit = MENTION_KIND_LIMIT,
): { note: NoteSummary; snippet: string | null }[] {
  const needle = term.trim().toLowerCase()
  const scored: { note: NoteSummary; snippet: string | null; score: number }[] = []
  for (const note of notes) {
    if (note.deleted_at || isEmptyThreadNote(note)) continue
    const snippet = bodyHits?.get(note.id) ?? null
    let score: number | null
    if (!needle) score = note.pinned ? 0 : projectId && note.project_id === projectId ? 1 : 2
    else {
      score = fuzzyScore(note.title, needle)
      if (score !== null && score >= 10) score = null
      if (score === null && note.preview.toLowerCase().includes(needle)) score = 6
      if (score === null && snippet !== null) score = 7
    }
    if (score !== null) scored.push({ note, snippet, score })
  }
  return scored
    .sort((a, b) => a.score - b.score || b.note.updated_at.localeCompare(a.note.updated_at))
    .slice(0, limit)
    .map(({ note, snippet }) => ({ note, snippet }))
}

/**
 * Tasks for the picker. Open tasks lead; without a query, this chat's project
 * comes first. A key ("ADE-14", "14") matches exactly; titles match loosely.
 */
export function rankMentionTasks(
  tasks: readonly TaskItem[],
  term: string,
  projectId: ProjectId | null | undefined,
  keyMatches: (key: string, query: string) => boolean,
  limit = MENTION_KIND_LIMIT,
): TaskItem[] {
  const needle = term.trim()
  const scored: { task: TaskItem; score: number }[] = []
  for (const task of tasks) {
    const closed = task.status === "done" || task.status === "canceled"
    let score: number | null
    if (!needle) score = (projectId && task.project_id === projectId ? 0 : 1) + (closed ? 4 : 0)
    else if (keyMatches(task.key, needle) || task.key.toLowerCase() === needle.toLowerCase()) score = -1
    else {
      const title = fuzzyScore(task.title, needle)
      const key = fuzzyScore(task.key, needle)
      score = title === null ? (key !== null && key < 10 ? key : null) : key === null ? title : Math.min(title, key)
      if (score !== null) score += closed ? 20 : 0
    }
    if (score !== null) scored.push({ task, score })
  }
  return scored
    .sort((a, b) => a.score - b.score || b.task.updated_at.localeCompare(a.task.updated_at))
    .slice(0, limit)
    .map(({ task }) => task)
}
