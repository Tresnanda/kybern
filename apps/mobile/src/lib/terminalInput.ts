// Native keyboards can append, delete, paste or replace composed text. Translate
// their edits into terminal bytes without replaying the already typed prefix.
export function terminalEdit(previous: string, next: string) {
  if (next.startsWith(previous)) return next.slice(previous.length);
  const before = Array.from(previous);
  const after = Array.from(next);
  let common = 0;
  while (
    common < before.length &&
    common < after.length &&
    before[common] === after[common]
  )
    common++;
  return "\x7f".repeat(before.length - common) + after.slice(common).join("");
}
