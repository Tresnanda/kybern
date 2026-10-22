/** Recent history stays small; browsing amortizes network round trips. */
export const EARLIER_HISTORY_ENTRIES = 120;
export const HISTORY_PREFETCH_SCREENS = 2;

/** An older page: whole turns (a page that ends inside a turn adds nothing a
 * turn-per-row transcript can show) and only the transcript (the first page
 * already carried the thread's tasks, usage and commands). Older daemons
 * ignore both fields and return the legacy page. */
export const EARLIER_HISTORY_PAGE = { transcript_limit: EARLIER_HISTORY_ENTRIES, whole_turns: true, transcript_only: true } as const;

/** The top row a reader sees: its turn and whether its prompt has loaded. */
export interface HistoryTop { key: string; prompt: boolean }

/** The oldest loaded turn of seq-ordered blocks; its prompt opens the turn. */
export function historyTop(blocks: readonly { turnId: string; kind: string }[]): HistoryTop {
  const key = blocks[0]?.turnId ?? "";
  let prompt = false;
  for (const block of blocks) {
    if (block.turnId !== key) break;
    if (block.kind === "user") { prompt = true; break; }
  }
  return { key, prompt };
}

/** True when a finished page left the top row as it was: the reader, still at
 * the top, saw nothing new, so the page must not consume their scroll intent. */
export function historyPageShowedNothing(before: HistoryTop, after: HistoryTop): boolean {
  return before.key === after.key && before.prompt === after.prompt;
}

/** One automatic attempt per cursor. A failure waits for an explicit retry. */
export function createHistoryPagingGate() {
  let attempted: number | null = null;
  return {
    claim(cursor: number | null, distance: number, viewport: number, enabled: boolean): boolean {
      if (!enabled || cursor === null || cursor === attempted || viewport <= 0 || distance > viewport * HISTORY_PREFETCH_SCREENS) return false;
      attempted = cursor;
      return true;
    },
    reset() { attempted = null; },
  };
}
