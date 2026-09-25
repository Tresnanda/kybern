// Display text for inline tokens, shared by sent messages and the composer.

export type InlineTokenKind = "skill" | "plugin" | "computer" | "thread" | "file" | "attachment"

/** `@"Title · Project"` → `Title · Project`; `@notes.md` → `notes.md`; `$animate` → `animate`. */
export function inlineTokenLabel(kind: InlineTokenKind, text: string): string {
  const body = text.slice(1)
  if (kind === "thread" && body.startsWith('"')) {
    try {
      return JSON.parse(body) as string
    } catch {
      return body.replace(/^"|"$/g, "")
    }
  }
  return body
}
