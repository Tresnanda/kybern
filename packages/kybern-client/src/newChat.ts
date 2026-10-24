// Optimistic new chats: the client picks the thread id, shows the thread (sidebar row, page, first
// bubble) on the frame of Enter, and asks the daemon to create it in the background. The daemon
// takes the id (`threads.create`, `tasks.items.send` and `coordinator.open` accept `thread_id` and
// `message_id`) and answers a repeat with the same ids from the first call, so Retry after a failure
// reuses the thread instead of leaving an orphan row and making a second one. Daemons before 0.15.0
// ignore the ids and name the thread themselves, so clients take this path only when
// `clientThreadIds` says the daemon honours them, and adopt whatever id a create returns. Pure and
// shared by the GPUIX and mobile clients.

import { partToken } from "./composerTokens.ts";
import type { MessageId, PermissionMode, ProjectId, ProviderInstance, Thread, ThreadId, UserMessage } from "./types.ts";

/** The quiet status line under the first message while the daemon makes a worktree. */
export const PREPARING_WORKTREE = "Preparing worktree…";
/** Shown when a failed create has no message of its own. */
export const NEW_CHAT_FAILED = "The chat could not start. Retry, or edit the message.";

/** The first daemon that takes the client's `thread_id` and `message_id` and answers a repeat idempotently. */
export const CLIENT_THREAD_IDS_MIN_VERSION = "0.15.0";

/** True when `version` ("0.15.0", "0.15.0-dev", "v0.16.2") is at least `minimum`. */
export function versionAtLeast(version: string | null | undefined, minimum: string): boolean {
  if (!version) return false;
  const parse = (value: string) => value.replace(/^v/, "").split(/[.-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(version);
  const b = parse(minimum);
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index]! > b[index]!;
  }
  return true;
}

/** Whether a daemon of `version` makes the thread the client named. Older ones get the awaited create. */
export const clientThreadIds = (version: string | null | undefined): boolean => versionAtLeast(version, CLIENT_THREAD_IDS_MIN_VERSION);

/** A UUID v7 (RFC 9562): 48 bits of Unix milliseconds, then random bits. `fill` supplies the randomness. */
export function uuidv7(now = Date.now(), fill: (bytes: Uint8Array<ArrayBuffer>) => void = (bytes) => crypto.getRandomValues(bytes)): string {
  const bytes = new Uint8Array(16);
  fill(bytes);
  let ms = Math.max(0, Math.floor(now));
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The daemon's `title_from_message`: the first non-empty line, at most 60 characters. */
export function titleFromMessage(message: UserMessage, fallback = "New thread"): string {
  const text = message.parts.map((part) => (part.type === "text" ? part.text : partToken(part) ?? "")).join("");
  const line = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  if (!line) return fallback;
  const chars = [...line];
  return chars.length > 60 ? `${chars.slice(0, 60).join("")}…` : line;
}

export interface OptimisticThreadInput {
  id: ThreadId;
  projectId: ProjectId;
  provider: ProviderInstance;
  model?: string | null;
  effort?: string | null;
  permissionMode: PermissionMode;
  message: UserMessage;
  /** A task run keeps the task's title; a Coordinator its own. */
  title?: string;
  coordinatorProjectId?: ProjectId | null;
  now?: Date;
}

/** The thread as the daemon will list it once it exists, shown until then. It reads as running: the
 *  first turn is what the user is waiting for. */
export function optimisticThread(input: OptimisticThreadInput): Thread {
  const at = (input.now ?? new Date()).toISOString();
  return {
    id: input.id,
    project_id: input.projectId,
    parent_thread_id: null,
    coordinator_project_id: input.coordinatorProjectId ?? null,
    title: input.title ?? titleFromMessage(input.message),
    provider: input.provider,
    model: input.model ?? null,
    effort: input.effort ?? null,
    permission_mode: input.permissionMode,
    status: "running",
    worktree: null,
    cwd: "",
    provider_session_id: null,
    pinned: false,
    created_at: at,
    updated_at: at,
    last_seq: 0,
  };
}

/**
 * The thread list with the optimistic threads the daemon has not listed yet, newest first after the
 * pinned ones. Returns the ids the daemon now lists, which the caller stops tracking: the server
 * copy keeps the same id, so its row stays mounted.
 */
export function mergeOptimisticThreads(server: readonly Thread[], local: Iterable<Thread>): { threads: Thread[]; listed: ThreadId[] } {
  const ids = new Set(server.map((thread) => thread.id));
  const listed: ThreadId[] = [];
  const extra: Thread[] = [];
  for (const thread of local) {
    if (ids.has(thread.id)) listed.push(thread.id);
    else extra.push(thread);
  }
  if (!extra.length) return { threads: [...server], listed };
  const pinned = server.filter((thread) => thread.pinned);
  const rest = server.filter((thread) => !thread.pinned);
  return { threads: [...pinned, ...extra.sort((a, b) => b.created_at.localeCompare(a.created_at)), ...rest], listed };
}

/** Where a new chat's create stands: in flight, done (the daemon has the thread), or failed. */
export type NewChatState = "creating" | "created" | "failed";

/** One new chat whose thread the client named. `create` is the call that makes it; a retry calls it
 *  again with the same ids, which the daemon answers idempotently. */
export interface NewChat {
  threadId: ThreadId;
  messageId: MessageId;
  message: UserMessage;
  /** The daemon makes a git worktree first: clients say "Preparing worktree…" until the turn runs. */
  worktree: boolean;
  thread: Thread;
  state: NewChatState;
  error?: string;
  /** The daemon made the thread under another id (it ignored ours): clients move to this one. */
  adoptedId?: ThreadId;
}

/** The thread id a create answered with: a `Thread`, its id, or nothing (the client's id stands). */
export function createdThreadId(result: Thread | ThreadId | void | null | undefined): ThreadId | undefined {
  if (!result) return undefined;
  return typeof result === "string" ? result : result.id;
}

export type NewChatCreate = (message: UserMessage, messageId: MessageId) => Promise<Thread | ThreadId | void>;

/**
 * The client's new chats, keyed by thread id. `start` begins a create and `retry` repeats a failed
 * one (optionally with an edited message and a fresh message id). A thread whose create never
 * reached the daemon has no row there, so any message to it goes through `retry` until it exists.
 */
export function createNewChats(
  options: {
    errorText?: (error: unknown) => string;
    limit?: number;
    /** A create answered with another thread id: move the page and pending message from `from` to `to`. */
    onAdopt?: (from: ThreadId, to: ThreadId, chat: NewChat) => void;
  } = {},
) {
  const errorText = options.errorText ?? ((error: unknown) => (error instanceof Error ? error.message : String(error)));
  const limit = options.limit ?? 32;
  const chats = new Map<ThreadId, NewChat & { create: NewChatCreate; run?: Promise<NewChat>; attempt?: object }>();
  const listeners = new Set<() => void>();
  const emit = () => { for (const listener of [...listeners]) listener(); };

  // Records are replaced, never changed in place, so `useSyncExternalStore` snapshots see each change.
  const run = (threadId: ThreadId): Promise<NewChat> => {
    const chat = chats.get(threadId)!;
    // Only the latest attempt for a thread records its outcome.
    const token = {};
    const settle = (patch: Partial<NewChat>): NewChat => {
      const current = chats.get(threadId);
      if (!current || current.attempt !== token) return current ?? chat;
      const next = { ...current, ...patch, attempt: undefined, run: undefined };
      chats.set(threadId, next);
      emit();
      if (next.adoptedId) options.onAdopt?.(threadId, next.adoptedId, next);
      return next;
    };
    const promise = new Promise<Thread | ThreadId | void>((resolve) => resolve(chat.create(chat.message, chat.messageId))).then(
      (result) => {
        const id = createdThreadId(result);
        return settle({ state: "created", error: undefined, ...(id && id !== threadId ? { adoptedId: id } : {}) });
      },
      // A failed chat shows as failed until the daemon lists it (when it made the row before the message failed).
      (error) => settle({ state: "failed", error: errorText(error), thread: { ...chat.thread, status: "failed" } }),
    );
    chats.set(threadId, { ...chat, attempt: token, run: promise });
    return promise;
  };

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    get: (threadId: ThreadId | null | undefined): NewChat | undefined => (threadId ? chats.get(threadId) : undefined),
    /** Threads to show that the daemon has not listed yet. An adopted chat's thread is the daemon's under its own id. */
    unlisted: (): Thread[] => [...chats.values()].filter((chat) => !chat.adoptedId).map((chat) => chat.thread),
    /** Whether the daemon has no row for this thread yet (its create is running or failed before it made one). */
    uncreated: (threadId: ThreadId | null | undefined) => !!threadId && chats.has(threadId) && chats.get(threadId)!.state !== "created",
    start(input: Omit<NewChat, "state" | "error">, create: NewChatCreate): Promise<NewChat> {
      chats.set(input.threadId, { ...input, state: "creating", create });
      while (chats.size > limit) {
        const oldest = [...chats.values()].find((chat) => chat.state !== "creating");
        if (!oldest) break;
        chats.delete(oldest.threadId);
      }
      emit();
      return run(input.threadId);
    },
    /** Repeat the create with the same thread id. An edited message comes with its own message id. */
    retry(threadId: ThreadId, edit?: { message: UserMessage; messageId: MessageId }): Promise<NewChat> | null {
      const chat = chats.get(threadId);
      if (!chat || chat.state === "creating") return chat?.run ?? null;
      chats.set(threadId, {
        ...chat,
        ...(edit ? { message: edit.message, messageId: edit.messageId } : {}),
        state: "creating",
        thread: { ...chat.thread, status: "running" },
        error: undefined,
      });
      emit();
      return run(threadId);
    },
    /** The daemon lists the thread now: its own copy takes over. That includes a create that failed here
     *  after it reached the daemon (a dropped connection): the thread exists, so it loads like any other. */
    listed(threadIds: readonly ThreadId[]) {
      const ids = new Set(threadIds);
      let changed = false;
      for (const [id, chat] of chats) {
        if (chat.state === "creating") continue;
        if (ids.has(id) || (chat.adoptedId && ids.has(chat.adoptedId))) { chats.delete(id); changed = true; }
      }
      if (changed) emit();
    },
    forget(threadId: ThreadId) {
      if (chats.delete(threadId)) emit();
    },
    clear() {
      if (!chats.size) return;
      chats.clear();
      emit();
    },
  };
}
export type NewChats = ReturnType<typeof createNewChats>;
