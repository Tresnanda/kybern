/** Largest number of harness logos on a delegated-agents row; the rest are not counted. */
export const MAX_HARNESS_MARKS = 3

/**
 * The distinct harnesses of a launch group, in the order they first appear, at most `MAX_HARNESS_MARKS`. A harness that is not
 * known yet (the call has no provider and no child thread) or has no logo is `null`, the generic mark, and counts once.
 */
export function launchHarnesses(kinds: readonly (string | null | undefined)[], hasMark: (kind: string) => boolean): (string | null)[] {
  const seen: (string | null)[] = []
  for (const raw of kinds) {
    const kind = raw && hasMark(raw) ? raw : null
    if (!seen.includes(kind)) seen.push(kind)
  }
  return seen.slice(0, MAX_HARNESS_MARKS)
}

/** Logo size and the step between logos for `count` marks: they overlap slightly and always fit the 24 px badge. */
export function harnessMarkGeometry(count: number): { size: number; step: number; width: number } {
  const size = count <= 1 ? 13 : count === 2 ? 11 : 8
  const step = count <= 1 ? 0 : count === 2 ? 9 : 7
  return { size, step, width: size + step * Math.max(0, count - 1) }
}
