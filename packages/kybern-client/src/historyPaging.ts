/** Recent history stays small; browsing amortizes network round trips. */
export const EARLIER_HISTORY_ENTRIES = 120;
export const HISTORY_PREFETCH_SCREENS = 2;

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
