// Display text for inline tokens, shared by sent messages and the composer.

import { parseKybernMention } from "./userInput.ts"

export type InlineTokenKind = "skill" | "plugin" | "computer" | "thread" | "note" | "task" | "file" | "attachment"

/** The chip kind for a `mention` part's path: `@Computer`, a Kybern note or task, or a plugin. */
export function mentionTokenKind(path: string): "computer" | "note" | "task" | "plugin" {
  return parseKybernMention(path)?.kind ?? "plugin"
}

/** `@"Title · Project"` → `Title · Project`; `@notes.md` → `notes.md`; `$animate` → `animate`. */
export function inlineTokenLabel(kind: InlineTokenKind, text: string): string {
  const body = text.slice(1)
  if ((kind === "thread" || kind === "note" || kind === "task") && body.startsWith('"')) {
    try {
      return JSON.parse(body) as string
    } catch {
      return body.replace(/^"|"$/g, "")
    }
  }
  return body
}
