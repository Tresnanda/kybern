// Tree connectors: the stem a parent hangs its children from, a tick into each child's icon and a rounded elbow
// on the last child (├─ … ╰─). Pure geometry, shared by the sidebar's nested threads, the transcript's work
// groups and the dock's Agents tree; `Tree.tsx` paints it.
//
// Each row draws its own slice of every line that passes it, edge to edge over the row's whole box, so stems stay
// one continuous hairline through rows of any height (wrapped titles, expanded results) and through virtual lists
// that recycle rows: nothing is measured, and a row's slices depend only on its own props.

/** One device pixel at 2x. Every macOS display GPUIX targets is Retina; the app's other hairlines use it too. */
export const HAIRLINE = 0.5
/** Radius of the last child's elbow, and the stem's gap around a chevron sitting on its junction. */
export const ELBOW = 6
/** Space between a tick's end and the icon it points at. */
export const TICK_GAP = 3

/**
 * How a row meets its parent's stem.
 * - `node`: a tee (├─), or the elbow (╰─) when it is the last child.
 * - `toggle`: the row's own chevron sits on the junction; the stem breaks around it and a tick runs on to the icon.
 * - `pass`: no tick (prose between the steps of a turn); the stem runs past while later children follow.
 */
export type Joint = 'node' | 'toggle' | 'pass'

export interface TreeShape {
  /** Stems of outer levels that run on past this row (x of each, in the row's coordinates). */
  rails?: readonly number[]
  /** The row's connector to its parent's stem at `x`; absent for a root row. */
  branch?: { x: number; joint: Joint; last: boolean; tickEnd: number }
  /** y of the joint: the centre line of the row's icon. */
  anchor: number
  /** A stem leaving below this row's own icon for its open children, from `from` to `to` (default: the row's bottom). */
  below?: { x: number; from: number; to?: number }
  /** Where the row's slices start; negative reaches up over a gap above the row (a group's top padding). */
  top?: number
  /** How far slices that continue run past the row's bottom: the gap to the next row of a flex column. */
  overlap?: number
}

/** A painted piece: a hairline box (`height` or `bottom`), or the elbow's quarter-round border (`corner`). */
export interface Segment {
  key: string
  left: number
  top: number
  width: number
  height?: number
  /** Distance from the row's bottom edge (negative runs past it). */
  bottom?: number
  /** Elbow radius: the box draws its left and bottom borders with this bottom-left radius. */
  corner?: number
  /** Which way the piece draws in: down a stem, out along a tick, round the elbow. */
  draw: 'down' | 'right' | 'corner' | 'none'
}

/** The pieces of one row. A line at `x` covers [x - line, x], so a whole-pixel x paints exactly one device pixel. */
export function treeSegments(shape: TreeShape, line = HAIRLINE): Segment[] {
  const top = shape.top ?? 0
  // Slices that continue run this far past the bottom edge (0, not -0, when there is no gap).
  const past = shape.overlap ? -shape.overlap : 0
  const out: Segment[] = []
  shape.rails?.forEach((x, i) => out.push({ key: `rail:${i}`, left: x - line, top, width: line, bottom: past, draw: 'none' }))
  const branch = shape.branch
  if (branch) {
    const { x, joint, last, tickEnd } = branch
    const knee = shape.anchor - ELBOW
    if (joint === 'pass') {
      if (!last) out.push({ key: 'stem', left: x - line, top, width: line, bottom: past, draw: 'down' })
    } else {
      out.push({ key: 'stem', left: x - line, top, width: line, height: Math.max(0, knee - top), draw: 'down' })
      if (joint === 'toggle') {
        if (!last) out.push({ key: 'tee', left: x - line, top: shape.anchor + ELBOW, width: line, bottom: past, draw: 'down' })
        out.push({ key: 'tick', left: x + ELBOW, top: shape.anchor - line, width: Math.max(0, tickEnd - x - ELBOW), height: line, draw: 'right' })
      } else if (last) {
        out.push({ key: 'elbow', left: x - line, top: knee, width: Math.max(ELBOW, tickEnd - x + line), height: ELBOW, corner: ELBOW, draw: 'corner' })
      } else {
        out.push({ key: 'tee', left: x - line, top: knee, width: line, bottom: past, draw: 'down' })
        out.push({ key: 'tick', left: x, top: shape.anchor - line, width: Math.max(0, tickEnd - x), height: line, draw: 'right' })
      }
    }
  }
  const below = shape.below
  if (below) {
    out.push(below.to === undefined
      ? { key: 'below', left: below.x - line, top: below.from, width: line, bottom: past, draw: 'down' }
      : { key: 'below', left: below.x - line, top: below.from, width: line, height: Math.max(0, below.to - below.from), draw: 'down' })
  }
  return out
}

export interface FlatTreeRow {
  /** No later sibling: this row ends its parent's stem. */
  last: boolean
  /** For each outer level 0 … depth - 2: whether that level's stem runs on past this row. */
  continues: boolean[]
  /** The next row is one of this row's children. */
  open: boolean
}

/**
 * Connector facts for a flat, pre-ordered list of depths (a virtual list's rows). A depth-0 row (or any row that
 * is not part of a tree, given depth 0) closes every open level. O(rows × depth).
 */
export function flatTree(depths: readonly number[]): FlatTreeRow[] {
  const out: FlatTreeRow[] = new Array(depths.length)
  // seen[d]: a row of depth d follows, before any shallower row (it is a later sibling at depth d).
  const seen: boolean[] = []
  for (let i = depths.length - 1; i >= 0; i--) {
    const depth = depths[i]!
    const continues: boolean[] = []
    for (let level = 0; level < depth - 1; level++) continues.push(!!seen[level + 1])
    out[i] = { last: !seen[depth], continues, open: (depths[i + 1] ?? -1) > depth }
    seen[depth] = true
    seen.length = depth + 1
  }
  return out
}
