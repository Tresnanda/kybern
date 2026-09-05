import type { ContentPart, SkillInfo } from "@/protocol"

interface StructuredToken {
  start: number
  end: number
  part: ContentPart
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Plugins answer to their display name ("@Computer Use") and their slug ("@computer-use"). */
export function pluginMentionNames(item: SkillInfo): string[] {
  return [...new Set([item.display_name?.trim() ?? "", item.name.trim()].filter(Boolean))]
}

/**
 * Turn picker-backed text tokens into wire-level parts without mistaking
 * ordinary shell variables for skills. Skill names come from the provider
 * catalog and may contain spaces, punctuation, or plugin namespaces.
 * Catalog entries scoped `plugin` are `@` mentions; everything else is a `$` skill.
 */
export function buildStructuredTextParts(text: string, mentionedPaths: ReadonlySet<string>, skillItems: readonly SkillInfo[]): ContentPart[] {
  const value = text.trim()
  if (!value) return []

  const tokens: StructuredToken[] = []
  const mentionPattern = /(^|\s)@([^\s]+)(?=\s|$)/g
  let mentionMatch: RegExpExecArray | null
  while ((mentionMatch = mentionPattern.exec(value))) {
    const path = mentionMatch[2]!
    if (!mentionedPaths.has(path)) continue
    const start = mentionMatch.index + mentionMatch[1]!.length
    tokens.push({ start, end: start + path.length + 1, part: { type: "file_mention", path } })
  }

  const skills = new Map<string, SkillInfo>()
  const plugins = new Map<string, SkillInfo>()
  for (const item of skillItems) {
    if (!item.enabled || !item.name.trim()) continue
    if (item.scope === "plugin") plugins.set(item.path, item)
    else skills.set(item.name.toLowerCase(), item)
  }
  const pluginNames = [...plugins.values()]
    .flatMap((item) => pluginMentionNames(item).map((alias) => ({ alias, item })))
    .sort((left, right) => right.alias.length - left.alias.length)
  for (const { alias, item } of pluginNames) {
    const pattern = new RegExp(`(^|\\s)@${escapeRegExp(alias)}(?=[\\s,.;:!?]|$)`, "gi")
    let match: RegExpExecArray | null
    while ((match = pattern.exec(value))) {
      const start = match.index + match[1]!.length
      tokens.push({
        start,
        end: start + alias.length + 1,
        part: { type: "mention", name: item.name, path: item.path, ...(item.display_name ? { display_name: item.display_name } : {}) },
      })
    }
  }
  const orderedSkills = [...skills.values()].sort((left, right) => right.name.length - left.name.length)
  for (const item of orderedSkills) {
    const pattern = new RegExp(`(^|\\s)\\$${escapeRegExp(item.name)}(?=\\s|$)`, "gi")
    let match: RegExpExecArray | null
    while ((match = pattern.exec(value))) {
      const start = match.index + match[1]!.length
      tokens.push({ start, end: start + item.name.length + 1, part: { type: "skill", name: item.name, path: item.path } })
    }
  }

  tokens.sort((left, right) => left.start - right.start || right.end - left.end)
  const parts: ContentPart[] = []
  let last = 0
  for (const token of tokens) {
    if (token.start < last) continue
    const before = value.slice(last, token.start)
    if (before) parts.push({ type: "text", text: before })
    parts.push(token.part)
    last = token.end
  }
  const rest = value.slice(last)
  if (rest || parts.length === 0) parts.push({ type: "text", text: rest })
  return parts
}
