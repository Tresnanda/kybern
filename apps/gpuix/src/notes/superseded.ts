// Where a note's retired claims sit on the page. The daemon retires a claim as `- ~~old line~~ (superseded 2026-10-25)`; the
// native editor strikes it through, and the note view dims it and labels it from these places (read once after typing pauses).
import { supersededDate } from '../../../../packages/kybern-client/src/notesHistory.ts'
import type { DocBlock } from '../editor/markdown.ts'

export interface SupersededBlock {
  /** Position in the document's block list. */
  index: number
  /** The block's top and height inside the editor, and where its first line of text starts. */
  top: number
  height: number
  textTop: number
  lineHeight: number
  /** `YYYY-MM-DD` from "(superseded …)". */
  date: string
}

/** The blocks that are a retired claim: struck text followed by "(superseded date)". `layout` is the editor's `layout` command. */
export function supersededBlocks(blocks: readonly DocBlock[], layout: readonly { top: number; height: number; ty: number; lineHeight: number | null }[]): SupersededBlock[] {
  const out: SupersededBlock[] = []
  blocks.forEach((block, index) => {
    const pieces = block.content
    if (!pieces?.length || !('text' in pieces[0]!) || !pieces[0].marks?.includes('strike')) return
    const date = supersededDate(pieces.map((piece) => ('text' in piece ? piece.text : '')).join(''))
    const place = layout[index]
    if (date && place) out.push({ index, top: place.top, height: place.height, textTop: place.ty, lineHeight: place.lineHeight ?? 20, date })
  })
  return out
}
