// Line-level reading of a note's Markdown, matching how the daemon edits notes.
//
// Folding the daemon's own line edits into a note that has unsaved typing: the
// daemon rewrites single lines of a note in place: it links a checklist line to the
// task made from it and ticks or unticks a linked line when the task's status
// changes. Those edits keep the line count, so each changed line can be found in
// the local text and replaced there. Anything less certain returns null and the
// note keeps its usual conflict handling. Pure, so it is testable in Node.

const lines = (text: string) => text.replace(/\n$/, "").split("\n")

/**
 * `mine` with the line edits that turned `base` into `theirs`, or null when
 * they cannot be placed without guessing.
 */
export function mergeNoteBodies(base: string, mine: string, theirs: string): string | null {
  if (mine.trimEnd() === base.trimEnd()) return theirs
  if (mine.trimEnd() === theirs.trimEnd()) return mine
  const before = lines(base)
  const after = lines(theirs)
  if (before.length !== after.length) return null
  const merged = lines(mine)
  for (let index = 0; index < before.length; index++) {
    const from = before[index]!
    const to = after[index]!
    if (from === to) continue
    const at: number[] = []
    merged.forEach((line, position) => line === from && at.push(position))
    if (at.length === 1) {
      merged[at[0]!] = to
      continue
    }
    // The same edit was made here too.
    if (at.length === 0 && merged.includes(to) && !before.includes(to)) continue
    return null
  }
  return `${merged.join("\n")}${mine.endsWith("\n") ? "\n" : ""}`
}

const CHECKLIST = /^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\](?:\s+(.*))?$/
const FENCE = /^\s*(```|~~~)/

/**
 * The text of the `index`-th checklist line (0-based, in document order, nested
 * items included, code skipped), as the daemon matches it when linking a task.
 */
export function checklistLine(markdown: string, index: number): string | null {
  let fenced = false
  let seen = 0
  for (const line of markdown.split("\n")) {
    if (FENCE.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    const match = CHECKLIST.exec(line)
    if (!match) continue
    if (seen++ === index) return (match[1] ?? "").trim()
  }
  return null
}
