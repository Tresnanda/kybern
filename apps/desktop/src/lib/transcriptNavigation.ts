import type { TurnGroup } from "../state/transcript"

export interface TranscriptNavigationItem {
  id: string
  label: string
  description?: string
  ariaLabel: string
  turnIndex: number
  role: "user" | "assistant"
}

function excerpt(source: string, limit: number): string {
  const plain = source.slice(0, 512).replace(/!?(\[([^\]]*)\])\([^)]*\)/g, "$2").replace(/[#*_`~]/g, "").replace(/\s+/g, " ").trim()
  if (plain.length <= limit) return plain
  const prefix = plain.slice(0, limit)
  const space = prefix.lastIndexOf(" ")
  return prefix.slice(0, space > limit * .65 ? space : limit).trimEnd() + "…"
}

/** Navigation describes every message, including rows that are not mounted.
 * Stable prefixes keep rail props unchanged throughout a growing response. */
export function createTranscriptNavigation() {
  const cache = new WeakMap<TurnGroup, { user: string; answer: string }>()
  let previous: TranscriptNavigationItem[] = []
  return (groups: readonly TurnGroup[]): TranscriptNavigationItem[] => {
    const next: TranscriptNavigationItem[] = []
    for (let turnIndex = 0; turnIndex < groups.length; turnIndex++) {
      const group = groups[turnIndex]!
      let text = cache.get(group)
      if (!text) {
        let user = ""
        for (const part of group.user?.message.parts ?? []) {
          if (part.type === "text") user += part.text.slice(0, 512 - user.length)
          if (user.length >= 512) break
        }
        text = { user, answer: group.answer?.text.slice(0, 512) ?? "" }
        cache.set(group, text)
      }
      if (group.user) next.push({
        id: group.user.id,
        label: excerpt(text.user, 56) || "Message",
        description: excerpt(text.answer, 88) || undefined,
        ariaLabel: "",
        turnIndex,
        role: "user",
      })
      if (!group.running) next.push({
        id: `${group.turnId || group.user?.id || turnIndex}:assistant`,
        label: excerpt(text.answer, 56) || "Assistant response",
        description: text.answer.length > 56 ? excerpt(text.answer.slice(56), 88) : undefined,
        ariaLabel: "",
        turnIndex,
        role: "assistant",
      })
    }
    next.forEach((item, index) => { item.ariaLabel = `Go to ${item.role} message ${index + 1} of ${next.length}` })
    const unchanged = next.length === previous.length && next.every((item, index) => {
      const old = previous[index]!
      return item.id === old.id && item.label === old.label && item.description === old.description && item.turnIndex === old.turnIndex && item.ariaLabel === old.ariaLabel
    })
    if (!unchanged) previous = next
    return previous
  }
}
