import type { UserMessage } from "./types.ts"

export function promptText(message: UserMessage): string {
  return message.parts.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n")
}

/** Editing a queued prompt must retain its attachments and structured context. */
export function replacePromptText(message: UserMessage, text: string): UserMessage {
  const parts = message.parts.filter((part) => part.type !== "text")
  return { ...message, parts: [{ type: "text", text }, ...parts] }
}
