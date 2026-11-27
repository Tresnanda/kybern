// The transcript lines an account switch leaves: "Switched to Work" and "Waiting until 15:00". The daemon's projection
// stores them as notices whose `data` is the event itself, and live events build the same rows, so clients read one shape.
//
// A wait and its end are one line: the end replaces the waiting words. A switch that a later switch follows is marked
// `superseded`, so only the newest one offers Undo.
import type { AccountSwitchReason, JsonValue, ProviderInstance } from "./types.ts";

export type AccountNotice =
  | { kind: "account_switched"; from: ProviderInstance; to: ProviderInstance; reason: AccountSwitchReason; superseded?: boolean }
  | { kind: "account_wait"; until: string; account?: ProviderInstance | null }
  | { kind: "account_wait_ended"; account?: ProviderInstance | null; cancelled: boolean };

const isInstance = (value: unknown): value is ProviderInstance =>
  !!value && typeof value === "object" && typeof (value as ProviderInstance).kind === "string" && typeof (value as ProviderInstance).instance === "string";

/** The account notice a notice row carries, or null. Unknown or partial data stays an ordinary notice. */
export function accountNotice(data: JsonValue | null | undefined): AccountNotice | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const value = data as unknown as Record<string, unknown>;
  switch (value.kind) {
    case "account_switched":
      return isInstance(value.from) && isInstance(value.to) ? (value as unknown as AccountNotice) : null;
    case "account_wait":
      return typeof value.until === "string" ? (value as unknown as AccountNotice) : null;
    case "account_wait_ended":
      return typeof value.cancelled === "boolean" ? (value as unknown as AccountNotice) : null;
    default:
      return null;
  }
}

interface NoticeRow {
  kind: string;
  text?: string;
  data?: JsonValue | null;
}

const noticeOf = (row: NoticeRow): AccountNotice | null => (row.kind === "notice" ? accountNotice(row.data) : null);

/**
 * Add one row to the transcript, folding a wait's end into its waiting line and marking the switches before a new one.
 * Returns the rows unchanged in identity wherever nothing about them changed.
 */
export function appendAccountNotice<T extends NoticeRow>(blocks: readonly T[], block: T): T[] {
  const notice = noticeOf(block);
  if (notice?.kind === "account_wait_ended") {
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (noticeOf(blocks[i]!)?.kind !== "account_wait") continue;
      const next = blocks.slice();
      next[i] = { ...blocks[i]!, text: block.text, data: block.data };
      return next;
    }
  }
  if (notice?.kind === "account_switched") {
    const next = blocks.map((row) => {
      const earlier = noticeOf(row);
      return earlier?.kind === "account_switched" && !earlier.superseded ? { ...row, data: { ...(row.data as object), superseded: true } as unknown as JsonValue } : row;
    });
    return [...next, block];
  }
  return [...blocks, block];
}

/** `appendAccountNotice` over a transcript read in one piece (or merged from two pages). */
export function foldAccountNotices<T extends NoticeRow>(blocks: readonly T[]): T[] {
  if (!blocks.some((row) => noticeOf(row))) return blocks as T[];
  let out: T[] = [];
  for (const row of blocks) out = appendAccountNotice(out, row);
  return out;
}
