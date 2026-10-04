// One open note: its saved copy, the local draft, and the autosave/conflict
// rules around them. Dependencies are injected so this stays free of React and
// native imports (and testable with a fake daemon).
import type { Note, NoteSummary, NotesChangedNotification } from "./protocol";
import { AUTOSAVE_MS, NOTES_CONFLICT, type NoteSaveStatus } from "./notesModel";

export type NoteTarget =
  | { kind: "id"; id: string }
  | { kind: "thread"; threadId: string }
  /** Nothing exists until the first non-empty save, so abandoned notes never pile up. */
  | { kind: "new"; projectId: string | null };

export interface NoteDraft {
  title: string;
  body: string;
  /** The revision this draft was written against. */
  baseRevision: number;
}
/** Unsaved drafts survive leaving and reopening a note while the app is open. */
export const noteDrafts = new Map<string, NoteDraft>();

export interface NoteSessionDeps {
  call: (method: string, params: Record<string, unknown>) => Promise<any>;
  subscribeChanges: (fn: (change: NotesChangedNotification) => void) => () => void;
  /** Namespaces drafts, usually by computer. */
  scope: string;
  errorText?: (e: unknown) => string;
}

export interface NoteSnapshot {
  loaded: boolean;
  loadError: string;
  /** The saved note. Null for a new note or a thread that has none yet. */
  note: Note | null;
  title: string;
  body: string;
  dirty: boolean;
  status: NoteSaveStatus;
  error: string;
  conflict: boolean;
  deleted: boolean;
  /** The id once the note exists, so a new note can switch to its permanent route. */
  id: string | null;
}

const draftKey = (scope: string, target: NoteTarget) =>
  target.kind === "new"
    ? ""
    : `${scope}:${target.kind === "id" ? target.id : `thread:${target.threadId}`}`;

export class NoteSession {
  private base: Note | null = null;
  private draft: NoteDraft | null = null;
  private expected = 0;
  private loaded = false;
  private loadError = "";
  private status: NoteSaveStatus = "idle";
  private error = "";
  private conflict = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inflight: Promise<void> | null = null;
  private listeners = new Set<() => void>();
  private off: (() => void) | null = null;
  private snap: NoteSnapshot;
  private target: NoteTarget;
  private key: string;

  private deps: NoteSessionDeps;

  constructor(target: NoteTarget, deps: NoteSessionDeps) {
    this.deps = deps;
    this.target = target;
    this.key = draftKey(deps.scope, target);
    if (target.kind === "new") this.loaded = true;
    this.snap = this.build();
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getSnapshot = () => this.snap;

  private emit() {
    this.snap = this.build();
    this.listeners.forEach((fn) => fn());
  }
  private build(): NoteSnapshot {
    const base = this.base;
    return {
      loaded: this.loaded,
      loadError: this.loadError,
      note: base,
      title: this.draft?.title ?? base?.title ?? "",
      body: this.draft?.body ?? base?.body ?? "",
      dirty: this.draft !== null,
      status: this.status,
      error: this.error,
      conflict: this.conflict,
      deleted: !!base?.deleted_at,
      id: base?.id ?? (this.target.kind === "id" ? this.target.id : null),
    };
  }
  private message(e: unknown) {
    return this.deps.errorText?.(e) ?? (e instanceof Error ? e.message : String(e));
  }
  private isConflict(e: unknown) {
    return (e as { code?: number } | null)?.code === NOTES_CONFLICT;
  }

  /** Start listening for edits made elsewhere. Pair with `detach`. */
  attach() {
    this.off ??= this.deps.subscribeChanges((change) => this.onChange(change));
  }
  detach() {
    this.off?.();
    this.off = null;
  }
  /** Leaving the note: stop watching and save whatever is pending. */
  async dispose() {
    this.detach();
    await this.flush();
  }

  private fetchLatest() {
    const target = this.target;
    return this.deps.call(
      "notes.get",
      target.kind === "thread" ? { thread_id: target.threadId } : target.kind === "id" ? { id: target.id } : {},
    ) as Promise<{ note?: Note | null }>;
  }

  /** Load the saved copy, and again after a reconnect. A local draft is kept. */
  async sync() {
    if (this.target.kind === "new" && !this.base) return;
    const target = this.target;
    try {
      const result =
        target.kind === "new"
          ? await this.deps.call("notes.get", { id: this.base!.id })
          : await this.fetchLatest();
      const note = result.note ?? null;
      if (!this.draft) {
        const saved = noteDrafts.get(this.key);
        if (saved) {
          this.draft = saved;
          this.expected = saved.baseRevision;
          if (note && note.revision > saved.baseRevision) {
            this.conflict = true;
            this.status = "conflict";
          } else this.scheduleSave();
          this.base = note;
        } else {
          this.base = note;
          this.expected = note?.revision ?? 0;
        }
      } else if (!this.saving()) {
        // Newer saved copy while we hold a draft: keep the draft, update metadata.
        this.base = note;
        if (note && note.revision > this.expected) {
          this.conflict = true;
          this.status = "conflict";
        }
      }
      this.loadError = "";
    } catch (e) {
      this.loadError = this.message(e);
    }
    this.loaded = true;
    this.emit();
  }

  private saving() {
    return this.inflight !== null;
  }

  setTitle(title: string) {
    this.edit({ title });
  }
  setBody(body: string) {
    this.edit({ body });
  }
  private edit(patch: Partial<Pick<NoteDraft, "title" | "body">>) {
    if (this.base?.deleted_at) return;
    const current = {
      title: this.draft?.title ?? this.base?.title ?? "",
      body: this.draft?.body ?? this.base?.body ?? "",
    };
    const next = { ...current, ...patch };
    if (
      this.base &&
      next.title === this.base.title &&
      next.body === this.base.body
    ) {
      this.draft = null;
      if (this.key) noteDrafts.delete(this.key);
      this.status = this.conflict ? "conflict" : "idle";
    } else if (next.title === "" && next.body === "" && !this.base) {
      // Nothing worth keeping yet.
      this.draft = null;
      this.status = "idle";
    } else {
      this.draft = { ...next, baseRevision: this.draft?.baseRevision ?? this.expected };
      if (this.key) noteDrafts.set(this.key, this.draft);
      if (!this.conflict) {
        this.status = "dirty";
        this.error = "";
        this.scheduleSave();
      }
    }
    this.emit();
  }

  private scheduleSave() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.save(), AUTOSAVE_MS);
  }

  /** Save now. Concurrent calls wait for the one in flight. */
  save(): Promise<void> {
    clearTimeout(this.timer);
    if (this.inflight) return this.inflight;
    if (!this.draft || this.conflict || this.base?.deleted_at) return Promise.resolve();
    const run = this.run().finally(() => {
      this.inflight = null;
    });
    this.inflight = run;
    return run;
  }

  private async run() {
    const sent = this.draft!;
    const target = this.target;
    this.status = "saving";
    this.error = "";
    this.emit();
    try {
      let result: Note | null = null;
      if (!this.base && target.kind === "new") {
        if (!sent.title.trim() && !sent.body.trim()) {
          this.draft = null;
        } else
          result = await this.deps.call("notes.create", {
            scope: target.projectId ? "project" : "global",
            project_id: target.projectId,
            title: sent.title,
            body: sent.body,
          });
      } else if (!this.base && target.kind === "thread" && !sent.body.trim()) {
        this.draft = null;
      } else if (target.kind === "thread") {
        result = await this.deps.call("notes.update", {
          thread_id: target.threadId,
          expected_revision: this.expected,
          body: sent.body,
        });
      } else {
        result = await this.deps.call("notes.update", {
          id: this.base!.id,
          expected_revision: this.expected,
          title: sent.title,
          body: sent.body,
        });
      }
      if (result) {
        this.base = result;
        this.expected = result.revision;
        if (this.draft === sent) this.draft = null;
        else if (this.draft) this.draft = { ...this.draft, baseRevision: this.expected };
      }
      if (!this.draft && this.key) noteDrafts.delete(this.key);
      if (this.draft) {
        if (this.key) noteDrafts.set(this.key, this.draft);
        this.status = "dirty";
        this.scheduleSave();
      } else this.status = result ? "saved" : "idle";
    } catch (e) {
      if (this.isConflict(e)) {
        this.conflict = true;
        this.status = "conflict";
      } else {
        this.error = this.message(e);
        this.status = "error";
      }
    }
    this.emit();
  }

  /** Save now and wait, including edits typed while a save was running. */
  async flush() {
    clearTimeout(this.timer);
    if (this.inflight) await this.inflight;
    if (this.draft && !this.conflict && this.status !== "error") await this.save();
  }
  /** Try again after a failed save. */
  retry() {
    if (this.status === "error") this.status = "dirty";
    return this.save();
  }

  /** Conflict: overwrite the other device's version with this draft. */
  async keepMine() {
    try {
      const latest = (await this.fetchLatestForConflict()).note ?? null;
      this.base = latest;
      this.expected = latest?.revision ?? 0;
      if (this.draft) this.draft = { ...this.draft, baseRevision: this.expected };
      this.conflict = false;
      this.status = "dirty";
      this.error = "";
      this.emit();
      await this.save();
    } catch (e) {
      this.error = this.message(e);
      this.status = "error";
      this.emit();
    }
  }
  /** Conflict: drop this draft and show the other device's version. */
  async loadTheirs() {
    try {
      const latest = (await this.fetchLatestForConflict()).note ?? null;
      this.base = latest;
      this.expected = latest?.revision ?? 0;
      this.draft = null;
      if (this.key) noteDrafts.delete(this.key);
      this.conflict = false;
      this.status = "idle";
      this.error = "";
    } catch (e) {
      this.error = this.message(e);
      this.status = "error";
    }
    this.emit();
  }
  private fetchLatestForConflict() {
    if (this.base?.id)
      return this.deps.call("notes.get", { id: this.base.id }) as Promise<{ note?: Note | null }>;
    return this.fetchLatest();
  }

  private mine(summary: NoteSummary) {
    const target = this.target;
    return (
      (this.base && summary.id === this.base.id) ||
      (target.kind === "id" && summary.id === target.id) ||
      (target.kind === "thread" && summary.thread_id === target.threadId)
    );
  }
  private onChange(change: NotesChangedNotification) {
    const summary = change.note;
    if (!summary || !this.mine(summary) || this.saving() || !this.loaded) return;
    if (summary.revision > this.expected) {
      // Someone else saved. Show it right away unless there is a local draft;
      // the draft then meets a conflict banner on its next save.
      if (!this.draft) void this.sync();
      return;
    }
    if (this.base && (summary.deleted_at ?? null) !== (this.base.deleted_at ?? null)) {
      this.base = { ...this.base, deleted_at: summary.deleted_at, pinned: summary.pinned };
      this.emit();
    }
  }
}
