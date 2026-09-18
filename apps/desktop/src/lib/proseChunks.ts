// Tall hosted paragraphs are split into bounded text chunks so each chunk can
// be its own small compositing layer. A wrapping `p`/`h*` taller than WebKit's
// tiling threshold (1024 CSS px at 2×) becomes a tiled layer; see
// perf/memory-tiles-2026-09-15.md and perf/paragraph-layer-2026-09-18.md.
// Chunks concatenate back to the source, so textContent, selection and copied
// text match the unchunked paragraph.

export const PROSE_CHUNK_CHARS = 1600

/** Prose chunks are a compositing wrap. Only hosted assistant markdown uses them. */
export function markdownHostsProse(className?: string): boolean {
  return /\bchat-markdown--hosted\b/.test(className ?? "")
}

/** Split plain prose so each piece stays under the tiling height at typical chat widths. Short strings are unchanged. */
export function chunkProseText(text: string, maxChars = PROSE_CHUNK_CHARS): string[] | null {
  if (text.length <= maxChars) return null
  const chunks: string[] = []
  let i = 0
  while (i < text.length) {
    let end = Math.min(i + maxChars, text.length)
    if (end < text.length) {
      const window = text.slice(i, end)
      const br = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "), window.lastIndexOf("\t"))
      if (br > 0) end = i + br + 1
    }
    chunks.push(text.slice(i, end))
    i = end
  }
  return chunks
}
