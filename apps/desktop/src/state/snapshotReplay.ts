import type { ThreadEvent } from "@/protocol"
import { retainedSize } from "@/lib/retainedSize"

/** Bounded bridge between a snapshot request and the live event stream. */
export function createSnapshotReplay(limit = 8 * 1024 * 1024) {
  let events: ThreadEvent[] = []
  let bytes = 0
  let highest = 0
  let overflow = false
  return {
    add(event: ThreadEvent) {
      highest = Math.max(highest, event.seq)
      if (overflow) return
      bytes += retainedSize(event)
      if (bytes > limit || events.length >= 2048) { overflow = true; events = []; return }
      events.push(event)
    },
    after(sequence: number): ThreadEvent[] | null {
      if (overflow) return sequence >= highest ? [] : null
      return events.filter((event) => event.seq > sequence).sort((a, b) => a.seq - b.seq)
    },
  }
}
