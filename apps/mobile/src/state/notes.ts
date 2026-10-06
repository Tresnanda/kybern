// Notes for the connected computer. The runtime attaches the live client on
// every connection: the list loads once the subscription is ready, again after
// each reconnect, and `notes.changed` notifications keep it current in between.
import { useCallback, useSyncExternalStore } from "react";
import {
  NOTES_CHANGED_NOTIFICATION,
  type KybernClient,
  type NoteSummary,
  type NotesChangedNotification,
} from "./protocol";
import {
  METHOD_NOT_FOUND,
  UNDO_MS,
  applyNoteChange,
  sortNotes,
} from "./notesModel";

export interface NotesState {
  notes: NoteSummary[];
  loaded: boolean;
  /** The computer's daemon predates notes. */
  unsupported: boolean;
  error: string;
  /** The most recent soft delete, offered as an Undo for a few seconds. */
  undo: { id: string; title: string } | null;
}
const initial: NotesState = {
  notes: [],
  loaded: false,
  unsupported: false,
  error: "",
  undo: null,
};
let state = initial;
const listeners = new Set<() => void>();
const changeListeners = new Set<(change: NotesChangedNotification) => void>();
let client: KybernClient | null = null;
let isCurrent: () => boolean = () => false;
let undoTimer: ReturnType<typeof setTimeout> | undefined;
let loading: Promise<void> | null = null;

function publish(patch: Partial<NotesState>) {
  state = { ...state, ...patch };
  listeners.forEach((fn) => fn());
}
const getState = () => state;

export function getNotes() {
  return state;
}
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
export function useNotes() {
  return useSyncExternalStore(subscribe, getState, getState);
}
/** One note's summary, live. Re-renders only when that note changes. */
export function useNote(id: string | undefined) {
  const get = useCallback(
    () => (id ? state.notes.find((note) => note.id === id) : undefined),
    [id],
  );
  return useSyncExternalStore(subscribe, get, get);
}
/** Whether the list has been read, so a missing note really is gone. */
export function useNotesKnown() {
  const get = useCallback(() => state.loaded && !state.unsupported, []);
  return useSyncExternalStore(subscribe, get, get);
}
/** Open editors watch for changes made on other devices. */
export function subscribeNoteChanges(
  fn: (change: NotesChangedNotification) => void,
) {
  changeListeners.add(fn);
  return () => {
    changeListeners.delete(fn);
  };
}

/** Called when the active computer changes: notes never leak across computers. */
export function resetNotes() {
  clearTimeout(undoTimer);
  undoTimer = undefined;
  client = null;
  isCurrent = () => false;
  loading = null;
  state = { ...initial };
  listeners.forEach((fn) => fn());
}

export function attachNotes(next: KybernClient, current: () => boolean) {
  client = next;
  isCurrent = current;
  next.onNotification(NOTES_CHANGED_NOTIFICATION, (params) => {
    if (!current() || client !== next || !params || typeof params !== "object")
      return;
    const change = params as NotesChangedNotification;
    publish({ notes: applyNoteChange(state.notes, change) });
    changeListeners.forEach((fn) => fn(change));
  });
}

function failure(e: unknown) {
  const code = (e as { code?: number } | null)?.code;
  if (code === METHOD_NOT_FOUND)
    return { unsupported: true, error: "" };
  return {
    unsupported: false,
    error: e instanceof Error ? e.message : String(e),
  };
}

/** Loads the full list. Safe to call repeatedly; overlapping calls share one request. */
export function loadNotes() {
  const active = client;
  if (!active) return Promise.resolve();
  if (loading) return loading;
  const request = active
    .call("notes.list", {})
    .then((result) => {
      if (client !== active || !isCurrent()) return;
      publish({
        notes: sortNotes(result.notes ?? []),
        loaded: true,
        unsupported: false,
        error: "",
      });
    })
    .catch((e) => {
      if (client !== active || !isCurrent()) return;
      publish({ loaded: true, ...failure(e) });
    })
    .finally(() => {
      if (loading === request) loading = null;
    });
  loading = request;
  return request;
}

function need() {
  if (!client) throw new Error("Connect to your computer to continue.");
  return client;
}
function fold(note: NoteSummary) {
  publish({ notes: applyNoteChange(state.notes, { note }) });
  return note;
}

export async function createNote(input: {
  projectId?: string | null;
  title?: string;
  body?: string;
}) {
  const note = await need().call("notes.create", {
    scope: input.projectId ? "project" : "global",
    project_id: input.projectId ?? null,
    title: input.title,
    body: input.body,
  });
  fold(note);
  return note;
}
export async function pinNote(id: string, pinned: boolean) {
  return fold(await need().call("notes.pin", { id, pinned }));
}
export async function moveNote(id: string, projectId: string | null) {
  return fold(
    await need().call("notes.move", {
      id,
      scope: projectId ? "project" : "global",
      project_id: projectId,
    }),
  );
}
export async function deleteNote(id: string) {
  const note = fold(await need().call("notes.delete", { id }));
  clearTimeout(undoTimer);
  publish({ undo: { id, title: note.title } });
  undoTimer = setTimeout(dismissUndo, UNDO_MS);
  return note;
}
export function dismissUndo() {
  clearTimeout(undoTimer);
  undoTimer = undefined;
  if (state.undo) publish({ undo: null });
}
export async function restoreNote(id: string) {
  if (state.undo?.id === id) dismissUndo();
  return fold(await need().call("notes.restore", { id }));
}
export async function purgeNote(id: string) {
  await need().call("notes.purge", { id });
  publish({ notes: applyNoteChange(state.notes, { purged_id: id }) });
}
export async function searchNotes(query: string) {
  return (await need().call("notes.search", { query, limit: 50 })).results ?? [];
}
