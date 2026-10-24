// The word beside a status glyph, one vocabulary for every list of work: runtime tasks (processes, monitors, agents) here,
// child threads in `delegations.ts` (`childState`). Sentence case; the glyph carries the colour, never the word alone.
import type { ChildPhase } from "./delegations.ts";
import type { RuntimeTaskStatus } from "./types.ts";

/** Word of a runtime task. A task kept running past its turn says so ("Running in background"). */
export function runtimeTaskStatusWord(status: RuntimeTaskStatus, backgrounded = false): string {
  switch (status) {
    case "pending":
      return "Starting";
    case "running":
      return backgrounded ? "Running in background" : "Running";
    case "waiting":
      return backgrounded ? "Monitoring in background" : "Waiting";
    case "stopping":
      return "Stopping";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "stopped":
      return "Stopped";
    case "interrupted":
      return "Interrupted";
  }
}

/** Glyph phase and word of a runtime task, in the shape `childState` returns for a child thread. A task that is
 *  starting, waiting on its monitor or stopping still counts as working: it is not finished and not waiting on the reader. */
export function runtimeTaskState(status: RuntimeTaskStatus, backgrounded = false): { phase: ChildPhase; word: string } {
  const word = runtimeTaskStatusWord(status, backgrounded);
  switch (status) {
    case "completed":
      return { phase: "done", word };
    case "failed":
      return { phase: "failed", word };
    case "stopped":
    case "interrupted":
      return { phase: "stopped", word };
    default:
      return { phase: "working", word };
  }
}
