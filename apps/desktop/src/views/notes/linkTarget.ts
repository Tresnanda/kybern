/** A pasted address like "example.com" becomes a link; anything with a scheme is kept. */
export function normalizeLinkTarget(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ""
  return /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`
}
