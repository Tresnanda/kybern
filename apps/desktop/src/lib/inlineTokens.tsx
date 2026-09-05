// Text helper for inline token chips: splits a string on known tokens and
// wraps each match in an InlineToken. Lives outside the component file so
// Fast Refresh keeps working for the chip itself.

import { InlineToken, type InlineTokenKind } from "@/components/kybern/InlineToken"

/** Split a string on known tokens (longest first) and wrap each match in a chip. */
export function renderWithTokens(text: string, tokens: ReadonlyMap<string, InlineTokenKind>): React.ReactNode {
  if (tokens.size === 0 || !text) return text
  const names = [...tokens.keys()].sort((a, b) => b.length - a.length).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  const pattern = new RegExp(`(^|\\s)(${names.join("|")})(?=[\\s,.;:!?)]|$)`, "g")
  const out: React.ReactNode[] = []
  let last = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text))) {
    const start = match.index + match[1]!.length
    const token = match[2]!
    if (start > last) out.push(text.slice(last, start))
    out.push(<InlineToken key={`${start}:${token}`} kind={tokens.get(token) ?? "skill"} text={token} />)
    last = start + token.length
  }
  if (last === 0) return text
  if (last < text.length) out.push(text.slice(last))
  return out
}
