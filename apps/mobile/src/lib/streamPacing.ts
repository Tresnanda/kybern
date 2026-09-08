// A short jitter buffer adapts to provider chunk size. The display is bounded
// behind ingress; completion, replacement, visibility and reduced motion flush
// in the hook rather than making users wait for an artificial typewriter.
export const REVEAL_INTERVAL_MS = 32;
export const MAX_BACKLOG = 2000;
export function advanceReveal(shown: number, target: number, elapsed: number) {
  if (target <= shown) return target;
  const dt = Math.max(0, Math.min(elapsed, 64));
  if (!dt) return shown;
  const start = Math.max(shown, target - MAX_BACKLOG);
  const step = Math.max(
    dt * 0.04,
    (target - start) * (1 - Math.exp(-dt / 180)),
  );
  return Math.min(target, start + step);
}

// Never publish half a UTF-16 surrogate pair. Include adjoining marks/ZWJ
// sequences together when already received, so a reveal does not tear emoji.
export function revealBoundary(text: string, requested: number) {
  let end = Math.max(0, Math.min(text.length, Math.floor(requested)));
  if (
    end > 0 &&
    /[\uD800-\uDBFF]/.test(text[end - 1]!) &&
    /[\uDC00-\uDFFF]/.test(text[end] ?? "")
  )
    end--;
  if (!end) return end;
  while (end < text.length) {
    const next = String.fromCodePoint(text.codePointAt(end)!);
    if (
      /^[\p{M}\uFE0F\u200D\u{1F3FB}-\u{1F3FF}]$/u.test(next) ||
      text[end - 1] === "\u200D"
    )
      end += next.length;
    else break;
  }
  return end;
}
