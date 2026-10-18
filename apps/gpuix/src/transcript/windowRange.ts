import {pixelWindowRange as transcriptWindowRangeBy} from '../kit/windowRange.ts'
export {pixelWindowRange as transcriptWindowRangeBy} from '../kit/windowRange.ts'

/** Fill by pixels, including the partially scrolled first row and native overdraw.
 * Zero-height image/gap slots are valid; they must not stop forward progress. */
export function transcriptWindowRange(heights: readonly number[], anchor: number, offset: number, viewport: number, overdraw = 1536) {
  return transcriptWindowRangeBy(heights.length, index => heights[index] ?? 160, anchor, offset, viewport, overdraw)
}

