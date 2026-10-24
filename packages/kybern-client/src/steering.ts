/** Agents whose running turn accepts steering (`threads.steer`). The others only queue a follow-up. */
export const STEERABLE: readonly string[] = ["claude-code", "codex", "pi", "omp"];

/** Whether a running turn of this agent takes a steer now: pass the kind, or anything carrying one (a `Thread.provider`). */
export function canSteer(provider: string | { kind: string } | null | undefined): boolean {
  const kind = typeof provider === "string" ? provider : provider?.kind;
  return !!kind && STEERABLE.includes(kind);
}
