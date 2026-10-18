/** Read only the local height neighborhood, even with tens of thousands of slots. */
export function pixelWindowRange(length: number, height: (index: number) => number, anchor: number, offset: number, viewport: number, overdraw = 1536) {
  let start = Math.max(0, Math.min(length, anchor))
  if (anchor >= length) {
    let remaining = viewport + overdraw
    while (start > 0 && remaining > 0) remaining -= Math.max(1, height(--start))
  } else {
    let remaining = overdraw
    while (start > 0 && remaining > 0) remaining -= Math.max(1, height(--start))
  }
  let end = Math.max(0, Math.min(length, anchor)), remaining = viewport + overdraw + Math.abs(offset)
  while (end < length && remaining > 0) remaining -= Math.max(1, height(end++))
  return { start, end }
}
