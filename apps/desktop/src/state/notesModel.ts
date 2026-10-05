// Notes list model: grouping, search, titles and the new-note scope rule. Pure
// helpers so the sidebar's organization is testable without React.
import type { NoteId, NoteSummary, Project, ProjectId, Thread, ThreadId } from "@/protocol"
import { isFreeChatProject } from "../../../../packages/kybern-client/src/types.ts"
import { orderProjects } from "./sidebarOrganize.ts"

/** Where a new note goes. Thread notes are created by the thread, never by choice. */
export type NoteHome = { scope: "global" } | { scope: "project"; projectId: ProjectId }

/** The list's own bookkeeping for the section the user last worked in. */
export type SectionFocus = { kind: "global" } | { kind: "project"; projectId: ProjectId } | null

export interface ProjectNotes {
  project: Pick<Project, "id" | "name">
  pages: NoteSummary[]
  /** Thread notes with something in them, newest first. */
  threadNotes: NoteSummary[]
}

export interface NotesGrouping {
  pinned: NoteSummary[]
  global: NoteSummary[]
  projects: ProjectNotes[]
  /** Notes of free chats: threads that belong to no project. */
  chats: NoteSummary[]
  deleted: NoteSummary[]
}

export const NOTE_RETENTION_DAYS = 30

export function noteTitle(note: Pick<NoteSummary, "title">): string {
  return note.title.trim() || "Untitled"
}

/** A thread note is empty until it has a body; the list leaves those out. */
export function isEmptyThreadNote(note: NoteSummary): boolean {
  return note.scope === "thread" && !note.preview.trim() && note.checklist.total === 0
}

const byRecent = (a: NoteSummary, b: NoteSummary) => b.updated_at.localeCompare(a.updated_at)
const byDeleted = (a: NoteSummary, b: NoteSummary) => (b.deleted_at ?? "").localeCompare(a.deleted_at ?? "")

/** Local title/preview match, used for instant filtering before the server answers. */
export function noteMatchesQuery(note: NoteSummary, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return note.title.toLowerCase().includes(needle) || note.preview.toLowerCase().includes(needle)
}

/**
 * Sections for the list. Pinned notes appear once, in Pinned. Projects follow the
 * sidebar's order and are included even when empty, so a project's notes are
 * always one click away.
 */
export function groupNotes(
  notes: readonly NoteSummary[],
  projects: Readonly<Record<ProjectId, Pick<Project, "id" | "name">>>,
  projectOrder: readonly ProjectId[],
): NotesGrouping {
  const live = notes.filter((note) => !note.deleted_at)
  const pinned = live.filter((note) => note.pinned && !isEmptyThreadNote(note)).sort(byRecent)
  const rest = live.filter((note) => !note.pinned).sort(byRecent)
  const result: NotesGrouping = {
    pinned,
    global: [],
    projects: [],
    chats: [],
    deleted: notes.filter((note) => !!note.deleted_at).sort(byDeleted),
  }
  const byProject = new Map<ProjectId, ProjectNotes>()
  const section = (projectId: ProjectId): ProjectNotes => {
    let entry = byProject.get(projectId)
    if (!entry) {
      entry = { project: projects[projectId] ?? { id: projectId, name: "Unknown project" }, pages: [], threadNotes: [] }
      byProject.set(projectId, entry)
    }
    return entry
  }
  for (const project of orderProjects(Object.values(projects), projectOrder)) {
    if (!isFreeChatProject(project.id)) section(project.id)
  }
  for (const note of rest) {
    if (note.scope === "global") result.global.push(note)
    else if (note.scope === "project" && note.project_id) section(note.project_id).pages.push(note)
    else if (note.scope === "thread") {
      if (isEmptyThreadNote(note)) continue
      if (!note.project_id || isFreeChatProject(note.project_id)) result.chats.push(note)
      else section(note.project_id).threadNotes.push(note)
    }
  }
  result.projects = [...byProject.values()]
  return result
}

/** Notes matching a search: local title/preview hits plus the daemon's body hits. */
export function searchNotes(
  notes: readonly NoteSummary[],
  query: string,
  bodyHits: ReadonlyMap<NoteId, string> | null,
): { note: NoteSummary; snippet: string | null }[] {
  const out: { note: NoteSummary; snippet: string | null }[] = []
  for (const note of notes) {
    if (note.deleted_at || isEmptyThreadNote(note)) continue
    const snippet = bodyHits?.get(note.id) ?? null
    if (snippet !== null || noteMatchesQuery(note, query)) {
      // The daemon's snippet shows the match in context; local-only hits use the preview.
      out.push({ note, snippet })
    }
  }
  return out.sort((a, b) => b.note.updated_at.localeCompare(a.note.updated_at))
}

/** "Global", the project's name, or "project › thread": where a note lives. */
export function noteScopeLabel(
  note: Pick<NoteSummary, "scope" | "project_id" | "thread_id" | "title" | "origin">,
  projects: Readonly<Record<ProjectId, Pick<Project, "id" | "name">>>,
  threads: Readonly<Record<ThreadId, Pick<Thread, "title">>>,
): string {
  if (note.scope === "global") return "Global"
  const project = note.project_id && !isFreeChatProject(note.project_id) ? projects[note.project_id]?.name : undefined
  if (note.scope === "project") return project ?? note.origin ?? "Project"
  const thread = note.thread_id ? threads[note.thread_id]?.title : undefined
  const title = (thread ?? note.title).trim() || "Untitled"
  return project ? `${project} › ${title}` : title
}

/**
 * Project sections worth showing: those with notes, plus any the user is looking at
 * (the current thread's project, the section last worked in). The rest stay one
 * click away in the "New note" scope menu.
 */
export function projectsToShow(entries: readonly ProjectNotes[], keep: readonly (ProjectId | null | undefined)[]): ProjectNotes[] {
  return entries.filter((entry) => entry.pages.length > 0 || entry.threadNotes.length > 0 || keep.includes(entry.project.id as ProjectId))
}

/** "Edited 3m ago", "Edited just now", or "Edited Oct 3" for older notes, from `relativeTime`'s output. */
export function editedLabel(time: string): string {
  if (!time) return ""
  if (time === "now") return "Edited just now"
  return /^\d+[mhdw]$/.test(time) ? `Edited ${time} ago` : `Edited ${time}`
}

/** Text split around the case-insensitive matches of `query`, for highlighting search hits. */
export function splitMatches(text: string, query: string): { text: string; match: boolean }[] {
  const needle = query.trim().toLowerCase()
  if (!needle || !text) return [{ text, match: false }]
  const haystack = text.toLowerCase()
  // Lowercasing can change a string's length (rare scripts); then skip highlighting.
  if (haystack.length !== text.length) return [{ text, match: false }]
  const parts: { text: string; match: boolean }[] = []
  let from = 0
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, from)) {
    if (at > from) parts.push({ text: text.slice(from, at), match: false })
    parts.push({ text: text.slice(at, at + needle.length), match: true })
    from = at + needle.length
  }
  if (from < text.length) parts.push({ text: text.slice(from), match: false })
  return parts
}

/** Days until a deleted note is removed for good: at least 0, never more than the retention. */
export function daysUntilPurge(deletedAt: string, now = Date.now()): number {
  const left = Date.parse(deletedAt) + NOTE_RETENTION_DAYS * 86_400_000 - now
  return Math.min(NOTE_RETENTION_DAYS, Math.max(0, Math.ceil(left / 86_400_000)))
}

/** "Deleted forever today", "tomorrow", or "in 12 days", from the time that is actually left. */
export function purgeLabel(deletedAt: string, now = Date.now()): string {
  const left = Date.parse(deletedAt) + NOTE_RETENTION_DAYS * 86_400_000 - now
  if (left < 86_400_000) return "Deleted forever today"
  if (left < 2 * 86_400_000) return "Deleted forever tomorrow"
  return `Deleted forever in ${daysUntilPurge(deletedAt, now)} days`
}

/**
 * Scope for a new note: the section being worked in, else the open note's own
 * place, else the current thread's project, else Global.
 */
export function resolveNewNoteHome(input: {
  focus: SectionFocus
  openNote: Pick<NoteSummary, "scope" | "project_id"> | null
  /** The project of the thread or draft the user came from, if any. */
  contextProjectId: ProjectId | null
  projects: Readonly<Record<ProjectId, unknown>>
}): NoteHome {
  const project = (projectId: ProjectId | null | undefined): NoteHome | null =>
    projectId && !isFreeChatProject(projectId) && projectId in input.projects ? { scope: "project", projectId } : null
  if (input.focus?.kind === "global") return { scope: "global" }
  if (input.focus?.kind === "project") {
    const home = project(input.focus.projectId)
    if (home) return home
  }
  if (input.openNote) {
    if (input.openNote.scope === "global") return { scope: "global" }
    const home = project(input.openNote.project_id)
    if (home) return home
  }
  return project(input.contextProjectId) ?? { scope: "global" }
}

/** A file name for "Export…": the note's title, without characters files dislike. */
export function exportFileName(title: string): string {
  const cleaned = [...title]
    .map((character) => (/[\\/:*?"<>|]/.test(character) || character.charCodeAt(0) < 32 ? "-" : character))
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
  return `${(cleaned || "Untitled").slice(0, 120)}.md`
}

/** Markdown for "Copy as Markdown": the title as a heading, then the body. */
export function noteMarkdown(title: string, body: string): string {
  const heading = title.trim()
  return heading ? `# ${heading}\n\n${body}`.trimEnd() + "\n" : body
}

/** A short title from the first line of some text, with Markdown marks removed. */
export function titleFromText(text: string, max = 60): string {
  const line =
    text
      .split("\n")
      .map((raw) =>
        raw
          .replace(/^\s*(?:>+\s*|#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, "")
          .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
          .replace(/[*_`~]/g, "")
          .replace(/\s+/g, " ")
          .trim(),
      )
      .find(Boolean) ?? ""
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

/** Quote text as Markdown: every line gets "> ", blank lines stay inside the quote. */
export function blockquote(text: string): string {
  return text
    .trim()
    .split("\n")
    .map((line) => (line.trim() ? `> ${line.trimEnd()}` : ">"))
    .join("\n")
}

/** The "From <thread>" link "Save to note" ends with; the app opens it in place. */
export function threadLink(title: string, threadId: ThreadId): string {
  const label = title.replace(/\s+/g, " ").replace(/[\\[\]]/g, "\\$&").trim() || "Untitled thread"
  return `[From ${label}](kybern://thread/${threadId})`
}

/** What "Save to note" adds to a note: the text as a quote, then where it came from. */
export function savedMessageMarkdown(text: string, threadTitle: string, threadId: ThreadId): string {
  return `${blockquote(text)}\n\n${threadLink(threadTitle, threadId)}`
}

// ---- the gallery: which notes a filter shows, and how they are grouped ----

/** What the gallery's filter row picks. */
export type NotesFilter =
  | { kind: "all" }
  | { kind: "global" }
  | { kind: "project"; projectId: ProjectId }
  | { kind: "threads" }
  | { kind: "deleted" }

export type NotesGroupBy = "none" | "date" | "project"
export type NotesSortBy = "edited" | "created" | "title"

export interface GallerySection {
  key: string
  /** Null for an unlabeled run of notes (Recent, when nothing is pinned above it). */
  label: string | null
  notes: NoteSummary[]
  pinned?: boolean
}

/** Notes a filter shows: live notes for the scopes, deleted ones (newest first) for Recently deleted. */
export function filterNotes(notes: readonly NoteSummary[], filter: NotesFilter): NoteSummary[] {
  if (filter.kind === "deleted") return notes.filter((note) => !!note.deleted_at).sort(byDeleted)
  return notes.filter((note) => {
    if (note.deleted_at || isEmptyThreadNote(note)) return false
    switch (filter.kind) {
      case "all":
        return true
      case "global":
        return note.scope === "global"
      case "threads":
        return note.scope === "thread"
      case "project":
        return note.scope !== "global" && note.project_id === filter.projectId
    }
  })
}

export function sortNotes(notes: readonly NoteSummary[], sort: NotesSortBy): NoteSummary[] {
  const list = [...notes]
  if (sort === "title") return list.sort((a, b) => noteTitle(a).localeCompare(noteTitle(b), undefined, { sensitivity: "base", numeric: true }) || byRecent(a, b))
  if (sort === "created") return list.sort((a, b) => b.created_at.localeCompare(a.created_at))
  return list.sort(byRecent)
}

const DAY_MS = 86_400_000
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]

/** "Today", "Yesterday", "Previous 7 days", "Previous 30 days", then the month ("March") or year ("2025"). */
export function dateBucket(iso: string, now = Date.now()): string {
  const at = new Date(iso)
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const start = today.getTime()
  const time = at.getTime()
  if (Number.isNaN(time)) return "Earlier"
  if (time >= start) return "Today"
  if (time >= start - DAY_MS) return "Yesterday"
  if (time >= start - 7 * DAY_MS) return "Previous 7 days"
  if (time >= start - 30 * DAY_MS) return "Previous 30 days"
  return at.getFullYear() === today.getFullYear() ? MONTHS[at.getMonth()]! : String(at.getFullYear())
}

/**
 * The gallery's sections: Pinned (unless the filter is Recently deleted), then the
 * rest as one run or grouped by date or project. Sections keep the chosen sort.
 */
export function gallerySections(
  notes: readonly NoteSummary[],
  options: {
    group: NotesGroupBy
    sort: NotesSortBy
    /** Recently deleted and search results are one flat run. */
    flat?: boolean
    projects: Readonly<Record<ProjectId, Pick<Project, "id" | "name">>>
    projectOrder: readonly ProjectId[]
    now?: number
  },
): GallerySection[] {
  const sorted = options.flat ? [...notes] : sortNotes(notes, options.sort)
  if (options.flat) return sorted.length ? [{ key: "all", label: null, notes: sorted }] : []
  const pinned = sorted.filter((note) => note.pinned)
  const rest = sorted.filter((note) => !note.pinned)
  const sections: GallerySection[] = []
  if (pinned.length) sections.push({ key: "pinned", label: "Pinned", notes: pinned, pinned: true })
  if (options.group === "none") {
    if (rest.length) sections.push({ key: "recent", label: "Recent", notes: rest })
    return sections
  }
  const buckets = new Map<string, NoteSummary[]>()
  const add = (key: string, note: NoteSummary) => {
    const list = buckets.get(key)
    if (list) list.push(note)
    else buckets.set(key, [note])
  }
  if (options.group === "date") {
    const field = options.sort === "created" ? "created_at" : "updated_at"
    // Grouping by date follows time even when sorted by title: buckets newest first, titles inside.
    const ordered = options.sort === "title" ? [...rest].sort((a, b) => b[field].localeCompare(a[field])) : rest
    for (const note of ordered) add(dateBucket(note[field], options.now), note)
    for (const [label, list] of buckets) sections.push({ key: `date:${label}`, label, notes: options.sort === "title" ? sortNotes(list, "title") : list })
    return sections
  }
  for (const note of rest) {
    const projectId = note.scope === "global" ? null : note.project_id
    add(projectId && !isFreeChatProject(projectId) ? `project:${projectId}` : note.scope === "global" ? "global" : "chats", note)
  }
  const order = ["global", ...orderProjects(Object.values(options.projects), options.projectOrder).map((project) => `project:${project.id}`), "chats"]
  for (const key of [...order, ...[...buckets.keys()].filter((key) => !order.includes(key))]) {
    const list = buckets.get(key)
    if (!list) continue
    const projectId = key.startsWith("project:") ? key.slice("project:".length) : null
    const label = key === "global" ? "Global" : key === "chats" ? "Chats" : options.projects[projectId as ProjectId]?.name ?? "Unknown project"
    sections.push({ key, label, notes: list })
  }
  return sections
}

/** What the filter row offers: projects that have notes (sidebar order), and whether thread and deleted notes exist. */
export function filterChoices(
  notes: readonly NoteSummary[],
  projects: Readonly<Record<ProjectId, Pick<Project, "id" | "name">>>,
  projectOrder: readonly ProjectId[],
): { projects: Pick<Project, "id" | "name">[]; threads: number; deleted: number } {
  const counts = new Map<string, number>()
  let threads = 0
  let deleted = 0
  for (const note of notes) {
    if (note.deleted_at) {
      deleted++
      continue
    }
    if (isEmptyThreadNote(note)) continue
    if (note.scope === "thread") threads++
    if (note.scope !== "global" && note.project_id && !isFreeChatProject(note.project_id)) counts.set(note.project_id, (counts.get(note.project_id) ?? 0) + 1)
  }
  return {
    projects: orderProjects(Object.values(projects), projectOrder).filter((project) => counts.has(project.id)),
    threads,
    deleted,
  }
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** "Just now", "2 min ago", "3 hours ago", "Yesterday", "Monday", "Oct 3", "Oct 3, 2025": when a note was edited, in words. */
export function ageLabel(iso: string, now = Date.now()): string {
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return ""
  const minutes = Math.floor((now - time) / 60_000)
  if (minutes < 1) return "Just now"
  if (minutes < 60) return `${minutes} min ago`
  const at = new Date(time)
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const hours = Math.floor(minutes / 60)
  if (time >= today.getTime()) return hours === 1 ? "1 hour ago" : `${hours} hours ago`
  if (time >= today.getTime() - DAY_MS) return "Yesterday"
  if (time >= today.getTime() - 6 * DAY_MS) return WEEKDAYS[at.getDay()]!
  const day = `${SHORT_MONTHS[at.getMonth()]} ${at.getDate()}`
  return at.getFullYear() === today.getFullYear() ? day : `${day}, ${at.getFullYear()}`
}

/** "Edited 2 min ago", "Edited yesterday", "Edited Monday": the document's meta line. */
export function editedAgo(iso: string, now = Date.now()): string {
  const age = ageLabel(iso, now)
  if (!age) return ""
  if (age === "Just now") return "Edited just now"
  if (age === "Yesterday") return "Edited yesterday"
  return age.endsWith("ago") || WEEKDAYS.includes(age) ? `Edited ${age}` : `Edited on ${age}`
}
