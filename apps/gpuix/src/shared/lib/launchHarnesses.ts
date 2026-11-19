/** Largest number of harness logos on a delegated-agents row: two plates fill the 24 px badge slot exactly. The rest are not counted. */
export const MAX_HARNESS_MARKS = 2

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

/**
 * The avatar stack for `count` marks in the 24 px badge slot. One mark keeps its single 13 px logo on the badge's own 24 px
 * circle. Two are 16 px plates overlapping by half (8 px), so the pair is exactly 24 px wide and centred on the slot's axis,
 * where the tree line hangs; each logo is 11 px and the 1.5 px ring is the surface behind the stack.
 */
export function harnessMarkGeometry(count: number): { plate: number; logo: number; step: number; ring: number; width: number } {
  if (count <= 1) return { plate: 24, logo: 13, step: 0, ring: 0, width: 24 }
  return { plate: 16, logo: 11, step: 8, ring: 1.5, width: 24 }
}
