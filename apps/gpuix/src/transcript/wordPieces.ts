// Long words in a sent message (ADE-118): the bubble's sentence is a wrapping row of word nodes (`InlineTokens.tsx`), so a
// word longer than a line, a tracking URL or a key, is drawn as short pieces the row can wrap between, its
// `overflow-wrap: anywhere`. Kept apart from the component so it can be tested without the renderer.

/** Words up to this long stay one piece. */
export const LONG_WORD = 20
/** The longest piece of a long word: about 65 px of body text, the most a wrapped line can fall short of its edge. */
export const PIECE = 8

/**
 * A word cut into pieces the row may wrap between: after URL punctuation (`/`, `?`, `&`, `=`, …), short neighbours merged,
 * and runs without any cut every `PIECE` characters. Joined, the pieces are the word. Short words come back whole.
 */
export function wordPieces(word: string): string[] {
  if (word.length <= LONG_WORD) return [word]
  const pieces: string[] = []
  let current = ''
  for (const part of word.split(/(?<=[/?&=#%\-_.,;:+~@!|\\])/)) {
    for (let at = 0; at < part.length; at += PIECE) {
      const chunk = part.slice(at, at + PIECE)
      if (current && current.length + chunk.length > PIECE) { pieces.push(current); current = '' }
      current += chunk
    }
  }
  if (current) pieces.push(current)
  return pieces
}
