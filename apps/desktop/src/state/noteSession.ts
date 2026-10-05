// One open note: loading it, tracking edits, and saving them without ever
// losing the draft. Autosave runs ~500 ms after typing stops and again when the
// note loses focus, the window hides, or the editor goes away. The unsaved
// draft is kept in localStorage until the daemon has it, so a failed save, a
// closed window, or a lost connection never costs the text.
import {
  codes,
  RpcCallError,
  type Note,
  type NoteId,
  type NoteSummary,
  type ThreadId,
} from "@/protocol"
import { mergeNoteBodies } from "./noteLines"
import { errorText } from "./rpc"
import { noteClient, recordSavedNote, useNotes, type NoteSource } from "./notes"

export type NoteTarget = { kind: "note"; id: NoteId } | { kind: "thread"; threadId: ThreadId }

export type SaveState = "saved" | "dirty" | "saving" | "retrying" | "error" | "conflict"

export interface SessionSnapshot {
  phase: "loading" | "ready" | "missing" | "failed"
  failure: string | null
  noteId: NoteId | null
  /** What the editor shows. The editor replaces its content when `epoch` changes. */
  content: { title: string; body: string }
  epoch: number
  save: SaveState
  saveError: string | null
  /** The daemon's newer version, while the user chooses which one to keep. */
  conflict: { theirs: Note } | null
  /** In Recently deleted: shown read-only until restored. */
  deleted: boolean
  /** Unsaved text from an earlier session was put back. */
  restoredDraft: boolean
}

interface Draft {
  title: string
  body: string
  baseRevision: number
  at: number
}

interface Base {
  id: NoteId | null
  revision: number
  title: string
  body: string
}

export const AUTOSAVE_MS = 500

/** Bodies are the same text even when only the trailing newline differs. */
const sameBody = (a: string, b: string) => a.trimEnd() === b.trimEnd()
const MAX_RETRY_MS = 15_000

export const draftKey = (ownerKey: string, target: NoteTarget) =>
  `kybern.notes.draft:${ownerKey}:${target.kind === "note" ? `note:${target.id}` : `thread:${target.threadId}`}`

export class NoteSession {
  readonly target: NoteTarget
  readonly source: NoteSource
  private readonly ownerKey: string
  private snap: SessionSnapshot
  private listeners = new Set<() => void>()
  private base: Base | null = null
  private title = ""
  private body = ""
  private bodyDirty = false
  private getBody: (() => string) | null = null
  private editSeq = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private retries = 0
  private inFlight = false
  /** The save in flight, for callers that must wait until the daemon has the text. */
  private saving: Promise<void> | null = null
  /** A newer revision whose line edits could not be folded into local typing. */
  private unmergeable = 0
  private loadToken = 0
  private attached = false
  private unsubscribeStore: (() => void) | null = null

  constructor(target: NoteTarget, source: NoteSource) {
    this.target = target
    this.source = source
    this.ownerKey = useNotes.getState()[source].ownerKey ?? source
    this.snap = {
      phase: "loading",
      failure: null,
      noteId: target.kind === "note" ? target.id : null,
      content: { title: "", body: "" },
      epoch: 0,
      save: "saved",
      saveError: null,
      conflict: null,
      deleted: false,
      restoredDraft: false,
    }
  }

  // ---- external store ----

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): SessionSnapshot => this.snap

  private set(patch: Partial<SessionSnapshot>) {
    this.snap = { ...this.snap, ...patch }
    this.listeners.forEach((listener) => listener())
  }

  private get isThread() {
    return this.target.kind === "thread"
  }

  // ---- lifecycle ----

  attach() {
    if (this.attached) return
    this.attached = true
    const token = ++this.loadToken
    this.unsubscribeStore = useNotes.subscribe(() => this.onListChanged())
    window.addEventListener("pagehide", this.onHide)
    document.addEventListener("visibilitychange", this.onVisibility)
    if (this.snap.phase === "loading" || this.snap.phase === "failed") void this.load(token)
  }

  /** Stop listening and write out what is pending. The draft survives a failed write. */
  detach() {
    if (!this.attached) return
    this.attached = false
    this.loadToken++
    this.unsubscribeStore?.()
    this.unsubscribeStore = null
    window.removeEventListener("pagehide", this.onHide)
    document.removeEventListener("visibilitychange", this.onVisibility)
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    if (this.snap.phase === "ready" && this.snap.save !== "conflict") void this.flush()
  }

  private onHide = () => {
    if (this.snap.phase === "ready" && this.hasPendingChanges()) {
      this.persistDraft()
      void this.flush()
    }
  }

  private onVisibility = () => {
    if (document.visibilityState === "hidden") this.onHide()
  }

  /** Try again after the note failed to open. */
  reload() {
    this.set({ phase: "loading", failure: null })
    void this.load(++this.loadToken)
  }

  // ---- loading ----

  private request() {
    return this.target.kind === "note" ? { id: this.target.id } : { thread_id: this.target.threadId }
  }

  private async fetchLatest(): Promise<Note | null> {
    const { note } = await noteClient(this.source).call("notes.get", this.request())
    return note ?? null
  }

  private async load(token: number) {
    try {
      const note = await this.fetchLatest()
      if (token !== this.loadToken) return
      if (!note && this.target.kind === "note") {
        this.set({ phase: "missing" })
        return
      }
      this.base = note
        ? { id: note.id, revision: note.revision, title: note.title, body: note.body }
        : { id: null, revision: 0, title: "", body: "" }
      this.title = this.base.title
      this.body = this.base.body
      this.bodyDirty = false
      const draft = this.readDraft()
      const differs = !!draft && (!sameBody(draft.body, this.base.body) || (!this.isThread && draft.title !== this.base.title))
      if (draft && differs) {
        this.title = this.isThread ? this.base.title : draft.title
        this.body = draft.body
        const conflicting = draft.baseRevision !== this.base.revision && !!note
        this.set({
          phase: "ready",
          noteId: this.base.id,
          content: { title: this.title, body: draft.body },
          epoch: this.snap.epoch + 1,
          deleted: !!note?.deleted_at,
          restoredDraft: true,
          conflict: conflicting ? { theirs: note } : null,
          save: conflicting ? "conflict" : "dirty",
        })
        if (!conflicting) this.scheduleSave()
        return
      }
      this.clearDraft()
      this.set({
        phase: "ready",
        noteId: this.base.id,
        content: { title: this.base.title, body: this.base.body },
        epoch: this.snap.epoch + 1,
        deleted: !!note?.deleted_at,
        save: "saved",
      })
    } catch (error) {
      if (token !== this.loadToken) return
      this.set({ phase: "failed", failure: errorText(error) })
    }
  }

  /**
   * The list changed: pick up another device's edit when there is nothing local to
   * lose, or fold the daemon's line edits (a task link, a ticked line) into unsaved typing.
   */
  private onListChanged() {
    const base = this.base
    if (!base || this.snap.phase !== "ready") return
    const summary: NoteSummary | undefined = base.id ? useNotes.getState()[this.source].notes[base.id] : undefined
    if (!summary) {
      if (base.id && useNotes.getState()[this.source].loaded) this.set({ phase: "missing" })
      return
    }
    const deleted = !!summary.deleted_at
    if (deleted !== this.snap.deleted) this.set({ deleted })
    if (summary.revision <= base.revision || this.inFlight || this.snap.save === "conflict") return
    if (this.hasPendingChanges() && summary.revision <= this.unmergeable) return
    const token = ++this.loadToken
    void this.adoptLatest(token)
  }

  private async adoptLatest(token: number) {
    try {
      const note = await this.fetchLatest()
      if (token !== this.loadToken || !note || this.inFlight) return
      if (!this.hasPendingChanges()) this.adopt(note)
      else this.mergeRemote(note)
    } catch {
      /* The next change retries. */
    }
  }

  /** Keep the local typing and apply the newer version's line edits under it. */
  private mergeRemote(note: Note) {
    const base = this.base
    if (!base || note.revision <= base.revision || this.snap.save === "conflict") return
    const titleClash = !this.isThread && this.title !== base.title && note.title !== base.title && note.title !== this.title
    const mine = this.currentDraft()
    const merged = titleClash ? null : mergeNoteBodies(base.body, mine.body, note.body)
    if (merged === null) {
      // Saving will meet the newer revision and offer the usual choice.
      this.unmergeable = note.revision
      return
    }
    if (!this.isThread && this.title === base.title) this.title = note.title
    this.base = { id: note.id, revision: note.revision, title: note.title, body: note.body }
    this.body = merged
    this.bodyDirty = false
    this.set({ content: { title: this.title, body: merged }, epoch: this.snap.epoch + 1, deleted: !!note.deleted_at })
    this.persistDraft()
    this.scheduleSave()
  }

  private adopt(note: Note) {
    this.base = { id: note.id, revision: note.revision, title: note.title, body: note.body }
    this.title = note.title
    this.body = note.body
    this.bodyDirty = false
    this.editSeq++
    this.clearDraft()
    this.set({
      noteId: note.id,
      content: { title: note.title, body: note.body },
      epoch: this.snap.epoch + 1,
      deleted: !!note.deleted_at,
      conflict: null,
      save: "saved",
      saveError: null,
    })
  }

  // ---- editing ----

  /** Let the session read the editor's Markdown when it is time to save. */
  bindBody(read: (() => string) | null) {
    if (!read && this.getBody && this.bodyDirty) this.body = this.getBody()
    this.getBody = read
  }

  setTitle(title: string) {
    if (title === this.title) return
    this.title = title
    this.markEdited()
  }

  /** The body changed. Markdown is read lazily, at save time. */
  bodyEdited() {
    this.bodyDirty = true
    this.markEdited()
  }

  private markEdited() {
    this.editSeq++
    if (this.snap.save === "conflict") return
    if (this.snap.save !== "saving") this.set({ save: "dirty", saveError: null })
    this.scheduleSave()
  }

  private scheduleSave() {
    clearTimeout(this.timer)
    clearTimeout(this.retryTimer)
    this.timer = setTimeout(() => void this.flush(), AUTOSAVE_MS)
  }

  /** The note as it reads right now, unsaved edits included. */
  currentText(): { title: string; body: string } {
    return this.currentDraft()
  }

  private currentDraft() {
    const body = this.bodyDirty && this.getBody ? this.getBody() : this.body
    this.body = body
    return { title: this.title, body }
  }

  private hasPendingChanges(): boolean {
    if (!this.base) return false
    if (this.timer !== undefined || this.snap.save === "dirty" || this.snap.save === "retrying") return true
    return this.bodyDirty || (!this.isThread && this.title !== this.base.title)
  }

  /**
   * Save now and wait until the daemon has the text, including a save already in
   * flight. True when the note is saved; false when it could not be (conflict,
   * error, offline, deleted).
   */
  async saveNow(): Promise<boolean> {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (this.saving) await this.saving
      await this.flush()
      if (!this.saving && !this.hasPendingChanges() && this.snap.save === "saved") return !!this.base?.id
      if (this.snap.save === "conflict" || this.snap.save === "error" || this.snap.deleted) return false
    }
    return false
  }

  /** Save now, if anything changed. Safe to call at any time. */
  async flush(): Promise<void> {
    if (this.saving) return
    const saving = this.write()
    this.saving = saving
    try {
      await saving
    } finally {
      if (this.saving === saving) this.saving = null
    }
    // A newer revision that arrived during the save is picked up now.
    if (this.attached) this.onListChanged()
  }

  private async write(): Promise<void> {
    clearTimeout(this.timer)
    this.timer = undefined
    const base = this.base
    if (!base || this.snap.phase !== "ready" || this.snap.save === "conflict" || this.snap.deleted) return
    if (this.inFlight) return
    const seq = this.editSeq
    const draft = this.currentDraft()
    const unchanged = sameBody(draft.body, base.body) && (this.isThread || draft.title === base.title)
    if (unchanged) {
      this.bodyDirty = false
      this.clearDraft()
      if (this.snap.save !== "saved") this.set({ save: "saved", saveError: null })
      return
    }
    // A thread's note exists once it has text; an empty one is not worth a row.
    if (this.isThread && !base.id && !draft.body.trim()) {
      this.clearDraft()
      this.set({ save: "saved", saveError: null })
      return
    }
    this.writeDraft(draft, base.revision)
    this.inFlight = true
    this.set({ save: "saving", saveError: null })
    try {
      const client = noteClient(this.source)
      const saved =
        base.id || this.target.kind === "note"
          ? await client.call("notes.update", {
              id: base.id ?? (this.target.kind === "note" ? this.target.id : null),
              expected_revision: base.revision,
              ...(this.isThread ? {} : { title: draft.title }),
              body: draft.body,
            })
          : await client.call("notes.update", {
              thread_id: this.target.kind === "thread" ? this.target.threadId : null,
              expected_revision: 0,
              body: draft.body,
            })
      this.inFlight = false
      this.retries = 0
      this.base = { id: saved.id, revision: saved.revision, title: saved.title, body: saved.body }
      recordSavedNote(this.source, saved)
      if (seq === this.editSeq) {
        this.bodyDirty = false
        this.body = draft.body
        this.clearDraft()
        this.set({ noteId: saved.id, save: "saved", saveError: null })
      } else {
        // Typing continued while this save was in flight.
        this.set({ noteId: saved.id, save: "dirty" })
        this.persistDraft()
        this.scheduleSave()
      }
    } catch (error) {
      this.inFlight = false
      await this.saveFailed(error)
    }
  }

  private async saveFailed(error: unknown) {
    if (error instanceof RpcCallError) {
      if (error.code === codes.CONFLICT) {
        await this.enterConflict()
        return
      }
      // The daemon refused this text; typing again tries again.
      this.set({ save: "error", saveError: error.message })
      return
    }
    // Network trouble: keep the draft and try again with a growing delay.
    this.set({ save: "retrying", saveError: errorText(error) })
    if (!this.attached) return
    const delay = Math.min(1000 * 2 ** this.retries++, MAX_RETRY_MS)
    clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => void this.flush(), delay)
  }

  private async enterConflict() {
    try {
      const theirs = await this.fetchLatest()
      if (!theirs) {
        this.set({ phase: "missing" })
        return
      }
      const mine = this.currentDraft()
      if (sameBody(mine.body, theirs.body) && (this.isThread || mine.title === theirs.title)) {
        // Both sides already agree.
        this.base = { id: theirs.id, revision: theirs.revision, title: theirs.title, body: theirs.body }
        this.bodyDirty = false
        this.clearDraft()
        this.set({ save: "saved", saveError: null })
        return
      }
      this.set({ save: "conflict", conflict: { theirs }, saveError: null })
    } catch (error) {
      await this.saveFailed(error)
    }
  }

  /** Overwrite the other device's version with this one. */
  keepMine() {
    const theirs = this.snap.conflict?.theirs
    if (!theirs) return
    this.base = { id: theirs.id, revision: theirs.revision, title: theirs.title, body: theirs.body }
    this.set({ conflict: null, save: "dirty" })
    void this.flush()
  }

  /** Replace this version with the other device's. */
  loadTheirs() {
    const theirs = this.snap.conflict?.theirs
    if (theirs) this.adopt(theirs)
  }

  // ---- draft storage ----

  private readDraft(): Draft | null {
    try {
      const value = JSON.parse(globalThis.localStorage?.getItem(draftKey(this.ownerKey, this.target)) ?? "null")
      return value && typeof value.body === "string" && typeof value.title === "string" && typeof value.baseRevision === "number" ? value : null
    } catch {
      return null
    }
  }

  private writeDraft(draft: { title: string; body: string }, baseRevision = this.base?.revision ?? 0) {
    try {
      const stored: Draft = { ...draft, baseRevision, at: Date.now() }
      globalThis.localStorage?.setItem(draftKey(this.ownerKey, this.target), JSON.stringify(stored))
    } catch {
      /* A full store must not stop the save itself. */
    }
  }

  private persistDraft() {
    if (this.base) this.writeDraft(this.currentDraft())
  }

  private clearDraft() {
    try {
      globalThis.localStorage?.removeItem(draftKey(this.ownerKey, this.target))
    } catch {
      /* Nothing to clear. */
    }
  }
}
