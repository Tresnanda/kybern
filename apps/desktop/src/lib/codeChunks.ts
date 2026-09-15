// Tall code blocks are split into fixed-size line chunks so each chunk can be
// its own small compositing layer. A single element taller than WebKit's
// tiling threshold (1024 CSS px at 2×) becomes a tiled layer whose tiles
// accumulate while it is scrolled through; see perf/memory-tiles-2026-09-15.md.
// Chunks keep every newline inside their text, so textContent, selection and
// copied text are identical to the unchunked block.

export const CODE_CHUNK_LINES = 40

const CODE_OPEN = "<code>"
const CODE_CLOSE = "</code>"

/** Wrap the lines of Shiki's `<code>` contents in block chunks. Short blocks are returned unchanged. */
export function chunkHighlightedHtml(html: string, linesPerChunk = CODE_CHUNK_LINES): string {
  const start = html.indexOf(CODE_OPEN)
  const end = html.lastIndexOf(CODE_CLOSE)
  if (start < 0 || end < start) return html
  const inner = html.slice(start + CODE_OPEN.length, end)
  // Shiki escapes source text, so the only newlines are its line separators.
  const lines = inner.split("\n")
  if (lines.length <= linesPerChunk) return html
  let out = ""
  for (let i = 0; i < lines.length; i += linesPerChunk) {
    const last = Math.min(i + linesPerChunk, lines.length)
    out += `<span class="chat-code-chunk">${lines.slice(i, last).join("\n")}${last < lines.length ? "\n" : ""}</span>`
  }
  return html.slice(0, start + CODE_OPEN.length) + out + html.slice(end)
}

/** Split plain code into chunk strings that concatenate back to the source. */
export function chunkPlainCode(code: string, linesPerChunk = CODE_CHUNK_LINES): string[] | null {
  const lines = code.split("\n")
  if (lines.length <= linesPerChunk) return null
  const chunks: string[] = []
  for (let i = 0; i < lines.length; i += linesPerChunk) {
    const last = Math.min(i + linesPerChunk, lines.length)
    chunks.push(lines.slice(i, last).join("\n") + (last < lines.length ? "\n" : ""))
  }
  return chunks
}
