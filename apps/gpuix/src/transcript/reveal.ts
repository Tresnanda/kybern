/** Reveal whole words where possible without stalling unbroken tokens or CJK.
 * Never cut a UTF-16 surrogate pair. Scan only the short trailing boundary. */
export function revealBoundary(text: string, position: number): number {
  let end = Math.min(text.length, Math.max(0, Math.floor(position)))
  if (end === text.length) return end
  if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--
  if (/\s/.test(text[end] ?? '')) return end
  for (let i = end - 1; i >= Math.max(0, end - 24); i--) {
    if (/\s/.test(text[i]!)) return i + 1
  }
  return end
}
