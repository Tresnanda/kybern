// A turn that shows nothing for a long time (a hung agent process, a lost network) says so instead of spinning on "Thinking".

/** How long an agent may stay silent before the transcript says so. */
export const SILENCE_AFTER_MS = 60_000;

/** "No response from Claude for 1m 12s", or null while the silence is still short. */
export function silenceNotice(silentMs: number, agent: string): string | null {
  if (!Number.isFinite(silentMs) || silentMs < SILENCE_AFTER_MS) return null;
  const seconds = Math.floor(silentMs / 1000);
  const text = seconds < 120 ? `${seconds} s` : `${Math.floor(seconds / 60)} min`;
  return `No response from ${agent} for ${text}`;
}
