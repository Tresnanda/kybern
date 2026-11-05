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
import { listCache } from "./listCache";
import { keepAway, listParams, networkTarget, ownerOf, recordList, resetOwners, setOwner, writable, writeClient } from "./federated";

export interface NotesState {
  notes: NoteSummary[];
  loaded: boolean;
  /** The computer's daemon predates notes. */
  unsupported: boolean;
  error: string;
  /** The most recent soft delete, offered as an Undo for a few seconds. `ids` holds every note it removed. */
  undo: { id: string; title: string; ids: string[] } | null;
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
/** The machine the notes belong to, for the offline copy (`listCache.ts`). */
let machine: string | undefined;
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
  machine = undefined;
  isCurrent = () => false;
  loading = null;
  resetOwners("notes");
  state = { ...initial };
  listeners.forEach((fn) => fn());
}

/**
 * `machineId` names the computer for the offline copy: until its list answers, the notes it
 * last had show read-only (the screens disable writes while it is away).
 */
export function attachNotes(next: KybernClient, current: () => boolean, machineId?: string) {
  client = next;
  machine = machineId;
  isCurrent = current;
  const cached = state.loaded ? undefined : listCache().get<NoteSummary & { __owner?: string }>(machineId, "notes");
  if (cached) publish({ notes: sortNotes(restoreOwners(cached)), loaded: true });
  next.onNotification(NOTES_CHANGED_NOTIFICATION, (params) => {
    if (!current() || client !== next || !params || typeof params !== "object")
      return;
    const change = params as NotesChangedNotification;
    publish({ notes: applyNoteChange(state.notes, change) });
    saveCopy();
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

/** The offline copy keeps who holds each note, so an away machine's notes stay read-only after a restart. */
function saveCopy() {
  listCache().put(machine, "notes", state.notes.map((note) => ({ ...note, __owner: ownerOf("notes", note.id) })));
}
function restoreOwners(items: (NoteSummary & { __owner?: string })[]): NoteSummary[] {
  return items.map(({ __owner, ...note }) => {
    setOwner("notes", note.id, __owner);
    return note;
  });
}

/**
 * Loads the full list through the network (`federated.ts`): every machine's notes once there are
 * several. Safe to call repeatedly; overlapping calls share one request.
 */
export function loadNotes() {
  const active = client;
  const target = networkTarget(client, machine);
  if (!active || !target) return Promise.resolve();
  if (loading) return loading;
  const request = target.client
    .call("notes.list", listParams())
    .then((result) => {
      if (client !== active || !isCurrent()) return;
      const fresh = result.notes ?? [];
      recordList("notes", fresh.map((note) => note.id), result.federation, target.machineId);
      publish({
        notes: sortNotes(keepAway("notes", fresh, state.notes, target.machineId)),
        loaded: true,
        unsupported: false,
        error: "",
      });
      saveCopy();
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

/** The client to write a note with: the machine that holds it, else the network's (`federated.ts`). */
function need(id?: string | null) {
  return writeClient("notes", id, client, machine);
}
/** The client for a note session's calls (`useNoteSession`). Throws when the note's machine is away. */
export function noteClient(id?: string | null) {
  return need(id);
}
/** A note can be changed now: its machine answers. */
export function noteWritable(id: string | null | undefined) {
  return writable("notes", id, client);
}
/** A note made here lives on the machine that answered. */
function made(note: NoteSummary) {
  setOwner("notes", note.id, networkTarget(client, machine)?.machineId);
  return note;
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
  const note = await need(null).call("notes.create", {
    scope: input.projectId ? "project" : "global",
    project_id: input.projectId ?? null,
    title: input.title,
    body: input.body,
  });
  fold(made(note));
  return note;
}
export async function pinNote(id: string, pinned: boolean) {
  return fold(await need(id).call("notes.pin", { id, pinned }));
}
export async function moveNote(id: string, projectId: string | null) {
  return fold(
    await need(id).call("notes.move", {
      id,
      scope: projectId ? "project" : "global",
      project_id: projectId,
    }),
  );
}
function offerUndo(ids: string[], title: string) {
  clearTimeout(undoTimer);
  publish({ undo: { id: ids[0]!, title, ids } });
  undoTimer = setTimeout(dismissUndo, UNDO_MS);
}
export async function deleteNote(id: string) {
  const note = fold(await need(id).call("notes.delete", { id }));
  offerUndo([id], note.title);
  return note;
}
/** Moves several notes to Recently deleted with one Undo ("Delete empty notes"). */
export async function deleteNotes(ids: string[]) {
  const done: string[] = [];
  try {
    for (const id of ids) {
      fold(await need(id).call("notes.delete", { id }));
      done.push(id);
    }
  } finally {
    if (done.length) offerUndo(done, "");
  }
}
/** Undoes the last delete, however many notes it removed. */
export async function restoreNotes(ids: string[]) {
  dismissUndo();
  for (const id of ids) fold(await need(id).call("notes.restore", { id }));
}
export function dismissUndo() {
  clearTimeout(undoTimer);
  undoTimer = undefined;
  if (state.undo) publish({ undo: null });
}
export async function restoreNote(id: string) {
  if (state.undo?.id === id) dismissUndo();
  return fold(await need(id).call("notes.restore", { id }));
}
export async function purgeNote(id: string) {
  await need(id).call("notes.purge", { id });
  publish({ notes: applyNoteChange(state.notes, { purged_id: id }) });
}
export async function searchNotes(query: string) {
  return (await need(null).call("notes.search", { query, limit: 50, ...listParams() })).results ?? [];
}
