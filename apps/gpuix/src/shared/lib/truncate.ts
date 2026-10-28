/** Keep the start and end of a long identifier: `feat/ui-rew…ade-30-33`. */
export function truncateMiddle(text: string, max: number): string {
  const chars = [...text]
  if (chars.length <= max || max < 3) return text
  const keep = max - 1
  const head = Math.ceil(keep / 2)
  const tail = keep - head
  return `${chars.slice(0, head).join("")}…${chars.slice(chars.length - tail).join("")}`
}
