import type { ContentPart, SkillInfo } from "@/protocol"

export interface StructuredToken {
  start: number
  end: number
  part: ContentPart
}

/** A run of the composer text: plain characters, or a recognised token with its wire part. */
export type StructuredSegment = { kind: "text"; text: string } | { kind: "token"; text: string; part: ContentPart }

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
  const parts: ContentPart[] = []
  for (const segment of structuredSegments(value, mentionedPaths, skillItems)) {
    if (segment.kind === "token") parts.push(segment.part)
    else if (segment.text) parts.push({ type: "text", text: segment.text })
  }
  if (parts.length === 0) parts.push({ type: "text", text: value })
  return parts
}

/**
 * Split text into plain runs and recognised tokens, in order, without trimming,
 * so the composer can paint the same tokens it will send exactly where they sit.
 */
export function structuredSegments(value: string, mentionedPaths: ReadonlySet<string>, skillItems: readonly SkillInfo[]): StructuredSegment[] {
  const segments: StructuredSegment[] = []
  let last = 0
  for (const token of structuredTokens(value, mentionedPaths, skillItems)) {
    if (token.start < last) continue
    const before = value.slice(last, token.start)
    if (before) segments.push({ kind: "text", text: before })
    segments.push({ kind: "token", text: value.slice(token.start, token.end), part: token.part })
    last = token.end
  }
  const rest = value.slice(last)
  if (rest || segments.length === 0) segments.push({ kind: "text", text: rest })
  return segments
}

/** Every recognised `@file`, `@plugin` and `$skill` token in `value`, sorted by position. */
export function structuredTokens(value: string, mentionedPaths: ReadonlySet<string>, skillItems: readonly SkillInfo[]): StructuredToken[] {
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
  return tokens
}

/** The literal text a structured part occupies in the message ("$skill", "@path"). */
export function partToken(part: ContentPart): string | null {
  switch (part.type) {
    case "skill":
      return `$${part.name}`
    case "mention":
      return `@${part.display_name ?? part.name}`
    case "file_mention":
      return `@${part.path}`
    default:
      return null
  }
}
