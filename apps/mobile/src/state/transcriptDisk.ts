// The phone's disk cache of opened transcripts (#248): the shared `TranscriptCache`
// (`packages/kybern-client/src/transcriptCache.ts`) over one expo-sqlite database.
// A thread opened before shows its cached copy on the first frame, then resumes
// from the cached `lastSeq`. Records are per (machine, thread); removing a machine
// wipes its records and forgetting the last machine wipes everything.
//
// expo-sqlite is a native module: a build without it (Expo Go older than the app,
// web) keeps no disk cache and every open reads the machine as before.
import { Platform } from "react-native";
import type * as SQLite from "expo-sqlite";
import {
  sqliteTranscriptCacheStore,
  TranscriptCache,
  type SqlDatabase,
  type TranscriptCacheStore,
} from "../../../../packages/kybern-client/src/transcriptCache";
import type { ThreadState } from "./transcript";

/** Bump whenever `CachedThread` (the saved `ThreadState`) changes shape. */
export const TRANSCRIPT_SCHEMA = 1;
const DATABASE = "kybern-transcripts.db";

/** What is saved of a thread: its state without the transient paging flag. */
export type CachedThread = Omit<ThreadState, "loadingEarlier">;

export function isCachedThread(data: unknown): data is CachedThread {
  const value = data as Partial<CachedThread> | null;
  return (
    !!value &&
    typeof value === "object" &&
    Array.isArray(value.blocks) &&
    Array.isArray(value.pendingApprovals) &&
    Array.isArray(value.tasks) &&
    typeof value.taskActivity === "object" &&
    typeof value.lastSeq === "number" &&
    !!value.thread &&
    typeof value.thread === "object"
  );
}

/** The `SqlDatabase` surface over expo-sqlite, opened on first use. */
export function expoSqlDatabase(name = DATABASE): SqlDatabase {
  let opened: Promise<SQLite.SQLiteDatabase> | undefined;
  // Loaded on first use: a build without the native module only loses the cache, it never fails to start.
  const db = () =>
    (opened ??= import("expo-sqlite").then((sqlite) => sqlite.openDatabaseAsync(name)).catch((error) => {
      opened = undefined;
      throw error;
    }));
  return {
    run: async (sql, params) => (await db()).runAsync(sql, params as SQLite.SQLiteBindParams),
    get: async <R,>(sql: string, params: readonly (string | number)[]) =>
      (await db()).getFirstAsync<R>(sql, params as SQLite.SQLiteBindParams),
    all: async <R,>(sql: string, params: readonly (string | number)[]) =>
      (await db()).getAllAsync<R>(sql, params as SQLite.SQLiteBindParams),
  };
}

/** A store whose table is created once before the first operation. */
function ensured(store: TranscriptCacheStore & { ensure(): unknown }): TranscriptCacheStore {
  let ready: Promise<unknown> | undefined;
  const ensure = () => (ready ??= Promise.resolve(store.ensure()).catch((error) => {
    ready = undefined;
    throw error;
  }));
  return {
    read: async (machineId, threadId) => (await ensure(), store.read(machineId, threadId)),
    write: async (row) => {
      await ensure();
      await store.write(row);
    },
    touch: async (machineId, threadId, usedAt) => {
      await ensure();
      await store.touch(machineId, threadId, usedAt);
    },
    remove: async (machineId, threadId) => {
      await ensure();
      await store.remove(machineId, threadId);
    },
    removeMachine: async (machineId) => {
      await ensure();
      await store.removeMachine(machineId);
    },
    clear: async () => {
      await ensure();
      await store.clear();
    },
    index: async () => (await ensure(), store.index()),
  };
}

/** The app's store: expo-sqlite on a phone, none on web. Tests pass their own to `createTranscriptDisk`. */
export function defaultTranscriptStore(name?: string): TranscriptCacheStore | undefined {
  if (Platform.OS === "web") return undefined;
  try {
    return ensured(sqliteTranscriptCacheStore(expoSqlDatabase(name)));
  } catch {
    return undefined;
  }
}

export function createTranscriptDisk(store: TranscriptCacheStore) {
  return new TranscriptCache<CachedThread>(store, {
    schema: TRANSCRIPT_SCHEMA,
    validate: isCachedThread,
    // A missing native module or a full disk only costs the cache; the app reads the machine as before.
    onError: () => {},
  });
}

/** Saved blocks per thread: a fully browsed long thread keeps its newest turns, from a turn's start. */
export const SAVED_BLOCKS = 400;

/** The part of a thread state that is saved: bounded, without the paging flag. */
export function savedThread(state: ThreadState): CachedThread {
  const { loadingEarlier: _, ...rest } = state;
  if (state.blocks.length <= SAVED_BLOCKS) return rest;
  let start = state.blocks.length - SAVED_BLOCKS;
  const turn = state.blocks[start]!.turnId;
  while (start < state.blocks.length && state.blocks[start]!.turnId === turn) start++;
  if (start >= state.blocks.length) start = state.blocks.length - SAVED_BLOCKS;
  const blocks = state.blocks.slice(start);
  // Earlier rows load again from the machine, from the first one kept.
  return { ...rest, blocks, nextBeforeSeq: blocks[0]!.seq };
}
