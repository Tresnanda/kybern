// Notes data layer. Two feeds of note summaries feed the list:
//   "env":  the active environment's daemon (its client is the window's own).
//   "home": the local Mac's daemon, a second small connection used only for
//           notes, while Global notes are shared across environments and this
//           window shows a different environment.
// Bodies are fetched per note by `noteSession.ts`; this module owns the list,
// the actions that change it, and the list's own UI state.
import { useMemo } from "react"
import { toast } from "sonner"
import { create } from "zustand"

import { openEnvironment } from "@/lib/environments"
import { getGlobalNotesHome, useGlobalNotesHome } from "@/lib/notesPrefs"
import {
  codes,
  ConnectionClosedError,
  KybernClient,
  NOTES_CHANGED_NOTIFICATION,
  RpcCallError,
  type Note,
  type NoteId,
  type NoteSummary,
  type NotesChangedNotification,
  type ProjectId,
} from "@/protocol"
import { reloadOnHotUpdate } from "@/lib/hot"
import { activeRuntime, errorText } from "./rpc"
import { useEnvironments } from "./environments"
import { useStore } from "./store"
import { resolveNewNoteHome, noteTitle, type NoteHome, type SectionFocus } from "./notesModel"

export type NoteSource = "env" | "home"
export type HomeStatus = "off" | "connecting" | "ready" | "unreachable"

interface Feed {
  /** The environment (env) or "local" (home) these summaries were read from. */
  ownerKey: string | null
  notes: Record<NoteId, NoteSummary>
  loaded: boolean
  /** False when the daemon predates notes. */
  supported: boolean
  error: string | null
}

export interface FocusRequest {
  noteId: NoteId | null
  target: "title" | "body"
  nonce: number
}

interface NotesState {
  env: Feed
  home: Feed & { status: HomeStatus }
  /** The section the user last worked in; decides where "New note" goes. */
  focus: SectionFocus
  /** Section open/closed overrides, by section key. */
  collapsed: Record<string, boolean>
  /** Set by actions that want the editor focused; the editor clears it. */
  focusRequest: FocusRequest | null
  /** The note open when the Notes page was last shown, for coming back to it. */
  lastOpenId: NoteId | undefined
}

const emptyFeed = (): Feed => ({ ownerKey: null, notes: {}, loaded: false, supported: true, error: null })

const COLLAPSED_KEY = "kybern.notes.sections"

function readCollapsed(): Record<string, boolean> {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(COLLAPSED_KEY) ?? "{}")
    return value && typeof value === "object" && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

export const useNotes = create<NotesState>()(() => ({
  env: emptyFeed(),
  home: { ...emptyFeed(), status: "off" },
  focus: null,
  collapsed: readCollapsed(),
  focusRequest: null,
  lastOpenId: undefined,
}))

// ---- feeds ----

let envClient: KybernClient | null = null
let homeClient: KybernClient | null = null
const generation: Record<NoteSource, number> = { env: 0, home: 0 }
/** Notifications that arrive while the list is loading wait here, then replay. */
const waiting: Partial<Record<NoteSource, NotesChangedNotification[]>> = {}

function patchFeed(source: NoteSource, patch: Partial<Feed> | ((feed: Feed) => Partial<Feed>)) {
  useNotes.setState((state) => {
    const feed = state[source]
    return { [source]: { ...feed, ...(typeof patch === "function" ? patch(feed) : patch) } } as Partial<NotesState>
  })
}

function mergeChange(notes: Record<NoteId, NoteSummary>, change: NotesChangedNotification): Record<NoteId, NoteSummary> {
  const next = { ...notes }
  if (change.purged_id) delete next[change.purged_id]
  const incoming = change.note
  if (incoming) {
    const existing = next[incoming.id]
    // Content revisions only move forward; pin/delete/restore share a revision.
    if (!existing || existing.revision <= incoming.revision) next[incoming.id] = incoming
  }
  return next
}

function applyChange(source: NoteSource, change: NotesChangedNotification) {
  const queue = waiting[source]
  if (queue) {
    queue.push(change)
    return
  }
  patchFeed(source, (feed) => ({ notes: mergeChange(feed.notes, change) }))
}

function isMissingMethod(error: unknown): boolean {
  return error instanceof RpcCallError && error.code === codes.METHOD_NOT_FOUND
}

async function loadFeed(source: NoteSource, client: KybernClient, token: number) {
  const queue: NotesChangedNotification[] = []
  waiting[source] = queue
  try {
    const { notes } = await client.call("notes.list", {})
    if (token !== generation[source]) return
    let map: Record<NoteId, NoteSummary> = Object.fromEntries(notes.map((note) => [note.id, note]))
    for (const change of queue) map = mergeChange(map, change)
    patchFeed(source, { notes: map, loaded: true, supported: true, error: null })
  } catch (error) {
    if (token !== generation[source]) return
    patchFeed(source, isMissingMethod(error)
      ? { loaded: true, supported: false, error: "This environment needs an update to use notes." }
      : { error: errorText(error) })
  } finally {
    if (waiting[source] === queue) delete waiting[source]
  }
}

/** Follow the active environment's notes until the returned function is called. */
export function attachEnvFeed(client: KybernClient, ownerKey: string): () => void {
  const token = ++generation.env
  envClient = client
  patchFeed("env", (feed) => (feed.ownerKey === ownerKey ? {} : { ...emptyFeed(), ownerKey }))
  const off = client.onNotification(NOTES_CHANGED_NOTIFICATION, (params) => applyChange("env", params as NotesChangedNotification))
  void loadFeed("env", client, token)
  return () => {
    off()
    if (generation.env === token) {
      envClient = null
      delete waiting.env
    }
  }
}

let stopHomeConnection: (() => void) | null = null
/** This Mac's daemon over HTTP, for the images in Global notes kept there. */
let homeEndpoint: { http_base: string; token: string } | null = null
let homeRetry: ReturnType<typeof setTimeout> | undefined

/** Open the small connection to this Mac's daemon that Global notes are read through. */
export function startHomeFeed() {
  stopHomeConnection?.()
  const token = ++generation.home
  clearTimeout(homeRetry)
  patchFeed("home", { ...emptyFeed(), ownerKey: "local" })
  useNotes.setState((state) => ({ home: { ...state.home, status: "connecting" } }))
  const unreachable = (message: string) => {
    useNotes.setState((state) => ({ home: { ...state.home, status: "unreachable", error: message } }))
  }
  void (async () => {
    try {
      const { profile, endpoint } = await openEnvironment("local")
      if (token !== generation.home) return
      const client = new KybernClient(
        { url: endpoint.url, token: endpoint.token },
        { expectedEnvironmentId: profile.environment_id ?? undefined },
      )
      homeClient = client
      homeEndpoint = endpoint
      const offNotification = client.onNotification(NOTES_CHANGED_NOTIFICATION, (params) => applyChange("home", params as NotesChangedNotification))
      const offStatus = client.onStatus((status, detail) => {
        if (token !== generation.home) return
        if (status === "open") {
          useNotes.setState((state) => ({ home: { ...state.home, status: "ready", error: null } }))
          void loadFeed("home", client, token)
        } else if (status === "reconnecting" || status === "failed") {
          unreachable(detail ?? "This Mac isn’t reachable")
        }
      })
      stopHomeConnection = () => {
        offNotification()
        offStatus()
        client.close()
        if (homeClient === client) homeClient = null
        if (homeEndpoint === endpoint) homeEndpoint = null
        stopHomeConnection = null
      }
      client.connect()
    } catch (error) {
      if (token !== generation.home) return
      unreachable(errorText(error))
      // The local daemon may simply not be running yet; look again shortly.
      homeRetry = setTimeout(() => {
        if (token === generation.home) startHomeFeed()
      }, 20_000)
    }
  })()
}

export function stopHomeFeed() {
  generation.home++
  clearTimeout(homeRetry)
  stopHomeConnection?.()
  delete waiting.home
  if (useNotes.getState().home.status !== "off") useNotes.setState({ home: { ...emptyFeed(), status: "off" } })
}

// ---- which notes this window shows ----

/** Global notes come from this Mac while shared, in a window showing another environment. */
export function isHomeShared(): boolean {
  return getGlobalNotesHome() === "shared" && useEnvironments.getState().selectedId !== "local"
}

export function visibleNotes(state: Pick<NotesState, "env" | "home">, shared: boolean): NoteSummary[] {
  const env = Object.values(state.env.notes)
  if (!shared) return env
  return [...env.filter((note) => note.scope !== "global"), ...Object.values(state.home.notes).filter((note) => note.scope === "global")]
}

/** Every note this window shows, deleted ones included. */
export function useAllNotes(): NoteSummary[] {
  const preference = useGlobalNotesHome()
  const environment = useEnvironments((s) => s.selectedId)
  const shared = preference === "shared" && environment !== "local"
  const env = useNotes((s) => s.env.notes)
  const home = useNotes((s) => s.home.notes)
  return useMemo(
    () => visibleNotes({ env: { ...emptyFeed(), notes: env }, home: { ...emptyFeed(), status: "off", notes: home } }, shared),
    [env, home, shared],
  )
}

export function locateNote(id: NoteId): { source: NoteSource; summary: NoteSummary } | null {
  const state = useNotes.getState()
  const shared = isHomeShared()
  const home = state.home.notes[id]
  if (shared && home?.scope === "global") return { source: "home", summary: home }
  const env = state.env.notes[id]
  if (env && !(shared && env.scope === "global")) return { source: "env", summary: env }
  return null
}

export function useNoteSummary(id: NoteId | null | undefined): NoteSummary | null {
  const all = useAllNotes()
  return useMemo(() => (id ? all.find((note) => note.id === id) ?? null : null), [all, id])
}

/** Whether notes have been read yet, and whether this environment can have them at all. */
export function useNotesReady(): { loaded: boolean; supported: boolean; error: string | null } {
  const env = useNotes((s) => s.env)
  const home = useNotes((s) => s.home)
  const preference = useGlobalNotesHome()
  const environment = useEnvironments((s) => s.selectedId)
  const shared = preference === "shared" && environment !== "local"
  // Global notes from This Mac may still be on their way, or not coming at all.
  const homeSettled = !shared || home.loaded || home.status === "unreachable"
  return { loaded: env.loaded && homeSettled, supported: env.supported, error: env.error }
}

/** Read the lists again, for "Try again" after a failure. */
export function refreshNotes() {
  const envFeed = useNotes.getState().env
  const client = envClient ?? activeEnvClient()
  if (client && (!envFeed.loaded || envFeed.error)) void loadFeed("env", client, generation.env)
  if (isHomeShared() && useNotes.getState().home.status !== "ready") startHomeFeed()
}

// ---- actions ----

const HOME_UNREACHABLE = "Global notes live on This Mac. Open Kybern on This Mac to see them."

/** The window's own client, before the feed has attached to it. */
function activeEnvClient(): KybernClient | null {
  try {
    return activeRuntime().rpc()
  } catch {
    return null
  }
}

function clientFor(source: NoteSource): KybernClient {
  const client = source === "env" ? envClient ?? activeEnvClient() : homeClient
  if (!client) {
    throw new ConnectionClosedError(source === "home" ? HOME_UNREACHABLE : "Reconnect to this environment before trying again")
  }
  return client
}

/** The daemon to read or write a note through. */
export function noteClient(source: NoteSource): KybernClient {
  return clientFor(source)
}

function sourceForHome(home: NoteHome): NoteSource {
  return home.scope === "global" && isHomeShared() ? "home" : "env"
}

/** The daemon a new note in `home` will be kept by. */
export const noteSourceForHome = sourceForHome

/** The daemon that keeps a note; one not listed yet (a thread note before its first save) is the environment's. */
export function noteSourceOf(id: NoteId | null | undefined): NoteSource {
  return (id && locateNote(id)?.source) || "env"
}

// ---- images ----
// A pasted image is kept by the daemon that keeps its note, as an asset; the note's
// Markdown holds only a `kybern://asset/<id>` link to it.

function homeHttp(): { http_base: string; token: string } {
  if (!homeEndpoint) throw new ConnectionClosedError(HOME_UNREACHABLE)
  return homeEndpoint
}

/** Keep an image with the daemon `source` names; resolves to its asset id. */
export async function uploadNoteImage(source: NoteSource, file: File): Promise<string> {
  if (source === "env") return (await activeRuntime().uploadFile(file)).id
  const home = homeHttp()
  const response = await fetch(`${home.http_base}/assets`, {
    method: "POST",
    headers: { authorization: `Bearer ${home.token}`, "content-type": file.type || "application/octet-stream", "x-kybern-filename": file.name || "image" },
    body: file,
  })
  if (!response.ok) throw new Error((await response.text()).trim() || `Upload failed (${response.status})`)
  return ((await response.json()) as { id: string }).id
}

async function readNoteImage(source: NoteSource, id: string, signal: AbortSignal): Promise<Blob> {
  if (source === "env") return activeRuntime().fetchAssetImage(id, signal)
  const home = homeHttp()
  const response = await fetch(`${home.http_base}/assets/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${home.token}` }, signal })
  if (!response.ok) throw new Error("Unable to load the image. Try again.")
  return response.blob()
}

/**
 * An image in a note, from the daemon that keeps the note, else from the other one:
 * a note moved between This Mac and an environment keeps links to where it was written.
 */
export async function fetchNoteImage(source: NoteSource, id: string, signal: AbortSignal): Promise<Blob> {
  try {
    return await readNoteImage(source, id, signal)
  } catch (error) {
    const other: NoteSource = source === "env" ? "home" : "env"
    if (signal.aborted || (other === "home" && !homeEndpoint)) throw error
    return readNoteImage(other, id, signal)
  }
}

function upsert(source: NoteSource, summary: NoteSummary) {
  applyChange(source, { note: summary })
}

function summaryOf(note: Note): NoteSummary {
  const summary: NoteSummary & { body?: string } = { ...note }
  delete summary.body
  return summary
}

/** Told about every note body this window saves or creates (the gallery's thumbnails listen). */
export const noteBodyListeners = new Set<(note: Note) => void>()

/** Record a saved note in the list right away, before the daemon's notification arrives. */
export function recordSavedNote(source: NoteSource, note: Note) {
  upsert(source, summaryOf(note))
  noteBodyListeners.forEach((listener) => listener(note))
}

export async function createNote(home: NoteHome, init: { title?: string; body?: string } = {}): Promise<{ note: Note; source: NoteSource }> {
  const source = sourceForHome(home)
  const note = await clientFor(source).call("notes.create", {
    scope: home.scope,
    project_id: home.scope === "project" ? home.projectId : null,
    ...init,
  })
  upsert(source, summaryOf(note))
  noteBodyListeners.forEach((listener) => listener(note))
  return { note, source }
}

/** The project of the thread or draft the user is looking at (or came from), if it has one. */
export function contextProjectIdOf(state: ReturnType<typeof useStore.getState>): ProjectId | null {
  const selected = state.selected
  if (selected.kind === "thread") return state.threads[selected.id]?.project_id ?? null
  if (selected.kind === "draft") return selected.draft.projectId ?? null
  const home = state.homeSelection
  if (home?.kind === "thread") return state.threads[home.id]?.project_id ?? null
  if (home?.kind === "draft") return home.draft.projectId ?? null
  return null
}

export function currentContextProjectId(): ProjectId | null {
  return contextProjectIdOf(useStore.getState())
}

/** Where "New note" puts a note right now. */
export function currentNewNoteHome(): NoteHome {
  const state = useStore.getState()
  const open = state.selected.kind === "notes" && state.selected.noteId ? locateNote(state.selected.noteId)?.summary ?? null : null
  return resolveNewNoteHome({
    focus: useNotes.getState().focus,
    openNote: open,
    contextProjectId: currentContextProjectId(),
    projects: state.projects,
  })
}

let focusNonce = 0

/** Ask the editor showing `noteId` to focus its title or body. */
export function requestEditorFocus(noteId: NoteId | null, target: "title" | "body") {
  useNotes.setState({ focusRequest: { noteId, target, nonce: ++focusNonce } })
}

export function clearFocusRequest(nonce: number) {
  if (useNotes.getState().focusRequest?.nonce === nonce) useNotes.setState({ focusRequest: null })
}

/** Open a note in the Notes page. */
export function openNote(noteId: NoteId, focus?: "title" | "body") {
  useStore.getState().set({ settingsOpen: false })
  useStore.getState().selectNotes(noteId)
  if (focus) requestEditorFocus(noteId, focus)
}

/** Create a note, open it, and focus its title. */
export async function createAndOpenNote(home: NoteHome = currentNewNoteHome()): Promise<NoteId | null> {
  try {
    const { note } = await createNote(home)
    openNote(note.id, "title")
    return note.id
  } catch (error) {
    toast.error("Unable to create the note", { description: errorText(error) })
    return null
  }
}

export async function pinNote(id: NoteId, pinned: boolean) {
  const located = locateNote(id)
  if (!located) return
  // Show the pin immediately; the daemon's answer settles it.
  upsert(located.source, { ...located.summary, pinned })
  try {
    upsert(located.source, await clientFor(located.source).call("notes.pin", { id, pinned }))
  } catch (error) {
    upsert(located.source, located.summary)
    toast.error(pinned ? "Unable to pin the note" : "Unable to unpin the note", { description: errorText(error) })
  }
}

/**
 * Move a note to Global or a project. Within one daemon that is a plain move; between
 * this Mac (shared Global notes) and another environment it copies the note across
 * and deletes the original, which stays in Recently deleted.
 */
export async function moveNote(id: NoteId, to: NoteHome): Promise<NoteId | null> {
  const located = locateNote(id)
  if (!located) return null
  const target = sourceForHome(to)
  try {
    if (target === located.source) {
      const summary = await clientFor(target).call("notes.move", { id, scope: to.scope, project_id: to.scope === "project" ? to.projectId : null })
      upsert(target, summary)
      return id
    }
    const { note } = await clientFor(located.source).call("notes.get", { id })
    if (!note) throw new Error("This note no longer exists.")
    const { note: copy } = await createNote(to, { title: note.title, body: note.body })
    if (note.pinned) await pinNote(copy.id, true)
    upsert(located.source, await clientFor(located.source).call("notes.delete", { id }))
    return copy.id
  } catch (error) {
    toast.error("Unable to move the note", { description: errorText(error) })
    return null
  }
}

export async function deleteNote(id: NoteId, options: { quiet?: boolean } = {}): Promise<boolean> {
  const located = locateNote(id)
  if (!located) return false
  try {
    upsert(located.source, await clientFor(located.source).call("notes.delete", { id }))
  } catch (error) {
    toast.error("Unable to delete the note", { description: errorText(error) })
    return false
  }
  if (options.quiet) return true
  toast(`Deleted “${noteTitle(located.summary)}”`, {
    duration: 8000,
    action: {
      label: "Undo",
      onClick: () => {
        void restoreNote(id).then((restored) => {
          // Back where it was: reopen it if the user is still on the Notes page.
          if (restored && useStore.getState().selected.kind === "notes") openNote(id)
        })
      },
    },
  })
  return true
}

export async function restoreNote(id: NoteId): Promise<boolean> {
  const located = locateNote(id)
  if (!located) return false
  try {
    upsert(located.source, await clientFor(located.source).call("notes.restore", { id }))
    return true
  } catch (error) {
    toast.error("Unable to restore the note", { description: errorText(error) })
    return false
  }
}

/** Delete a note for good. The caller confirms first. */
export async function purgeNote(id: NoteId): Promise<boolean> {
  const located = locateNote(id)
  if (!located) return false
  try {
    await clientFor(located.source).call("notes.purge", { id })
    applyChange(located.source, { purged_id: id })
    return true
  } catch (error) {
    toast.error("Unable to delete the note", { description: errorText(error) })
    return false
  }
}

/**
 * Add Markdown to the end of a note, for "Save to note" and quick capture. Retries once
 * when the note changed while it was being read.
 */
export async function appendToNote(id: NoteId, markdown: string): Promise<Note> {
  const located = locateNote(id)
  const source = located?.source ?? "env"
  const client = clientFor(source)
  const addition = markdown.trim()
  for (let attempt = 0; ; attempt++) {
    const { note } = await client.call("notes.get", { id })
    if (!note) throw new Error("This note no longer exists. Choose another note.")
    if (note.deleted_at) throw new Error("Restore this note before adding to it.")
    const existing = note.body.trimEnd()
    const body = existing ? `${existing}\n\n${addition}\n` : `${addition}\n`
    try {
      const saved = await client.call("notes.update", { id, expected_revision: note.revision, body })
      upsert(source, summaryOf(saved))
      noteBodyListeners.forEach((listener) => listener(saved))
      return saved
    } catch (error) {
      if (attempt === 0 && error instanceof RpcCallError && error.code === codes.CONFLICT) continue
      throw error
    }
  }
}

/** Body matches for a search, from this environment and, when shared, this Mac. */
export async function searchNoteBodies(query: string): Promise<Map<NoteId, string>> {
  const hits = new Map<NoteId, string>()
  const sources: NoteSource[] = isHomeShared() ? ["env", "home"] : ["env"]
  await Promise.all(
    sources.map(async (source) => {
      const client = source === "env" ? envClient ?? activeEnvClient() : homeClient
      if (!client) return
      try {
        const { results } = await client.call("notes.search", { query, limit: 50 })
        for (const result of results) hits.set(result.id, result.snippet)
      } catch {
        /* Title and preview matches still show. */
      }
    }),
  )
  return hits
}

export function setSectionFocus(focus: SectionFocus) {
  useNotes.setState({ focus })
}

export function setSectionCollapsed(key: string, collapsed: boolean) {
  useNotes.setState((state) => {
    const next = { ...state.collapsed, [key]: collapsed }
    try {
      globalThis.localStorage?.setItem(COLLAPSED_KEY, JSON.stringify(next))
    } catch {
      /* The section still toggles for this session. */
    }
    return { collapsed: next }
  })
}

reloadOnHotUpdate(import.meta.hot)
