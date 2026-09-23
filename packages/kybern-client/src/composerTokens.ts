import type { ContentPart, SkillInfo } from "./types.ts"
import { formatThreadReference, type ComposerThreadReference } from "./threadReferences.ts"

/** A composer attachment addressable inline as `@image1` or `@file1`. */
export interface AttachmentReference {
  token: string
  part: Extract<ContentPart, { type: "attachment" }>
}

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
export function buildStructuredTextParts(text: string, mentionedPaths: ReadonlySet<string>, skillItems: readonly SkillInfo[], threadReferences: readonly ComposerThreadReference[] = [], attachmentReferences: readonly AttachmentReference[] = []): ContentPart[] {
  const value = text.trim()
  if (!value) return []
  const parts: ContentPart[] = []
  const pushText = (text: string) => {
    const previous = parts.at(-1)
    if (previous?.type === "text") parts[parts.length - 1] = { type: "text", text: previous.text + text }
    else parts.push({ type: "text", text })
  }
  // An attachment rides directly after its first `@image1`, so the agent sees
  // the file where the prompt refers to it. Later mentions stay plain text.
  const placed = new Set<string>()
  for (const segment of structuredSegments(value, mentionedPaths, skillItems, threadReferences, attachmentReferences)) {
    if (segment.kind === "token" && segment.part.type === "attachment") {
      pushText(segment.text)
      if (!placed.has(segment.part.asset_id)) parts.push(segment.part)
      placed.add(segment.part.asset_id)
    } else if (segment.kind === "token") parts.push(segment.part)
    else if (segment.text) pushText(segment.text)
  }
  if (parts.length === 0) parts.push({ type: "text", text: value })
  return parts
}

/**
 * Split text into plain runs and recognised tokens, in order, without trimming,
 * so the composer can paint the same tokens it will send exactly where they sit.
 */
export function structuredSegments(value: string, mentionedPaths: ReadonlySet<string>, skillItems: readonly SkillInfo[], threadReferences: readonly ComposerThreadReference[] = [], attachmentReferences: readonly AttachmentReference[] = []): StructuredSegment[] {
  const segments: StructuredSegment[] = []
  let last = 0
  for (const token of structuredTokens(value, mentionedPaths, skillItems, threadReferences, attachmentReferences)) {
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

/** Every recognised `@attachment`, `@file`, `@plugin` and `$skill` token in `value`, sorted by position. */
export function structuredTokens(value: string, mentionedPaths: ReadonlySet<string>, skillItems: readonly SkillInfo[], threadReferences: readonly ComposerThreadReference[] = [], attachmentReferences: readonly AttachmentReference[] = []): StructuredToken[] {
  const tokens: StructuredToken[] = []
  for (const reference of attachmentReferences) {
    const pattern = new RegExp(`(^|\\s)${escapeRegExp(reference.token)}(?=[\\s,.;:!?]|$)`, "g")
    let match: RegExpExecArray | null
    while ((match = pattern.exec(value))) {
      const start = match.index + match[1]!.length
      tokens.push({ start, end: start + reference.token.length, part: reference.part })
    }
  }
  const references = new Map<string, ComposerThreadReference | null>()
  for (const reference of threadReferences) {
    if (!reference.token || !reference.part.thread_id) continue
    const previous = references.get(reference.token)
    references.set(reference.token, previous === null || (previous && previous.part.thread_id !== reference.part.thread_id) ? null : reference)
  }
  for (const reference of references.values()) {
    if (!reference) continue
    const pattern = new RegExp(`(^|\\s)${escapeRegExp(reference.token)}(?=[\\s,.;:!?]|$)`, "g")
    let match: RegExpExecArray | null
    while ((match = pattern.exec(value))) {
      const start = match.index + match[1]!.length
      tokens.push({ start, end: start + reference.token.length, part: reference.part })
    }
  }
  for (const path of [...mentionedPaths].sort((a, b) => b.length - a.length)) {
    const pattern = new RegExp(`(^|\\s)@${escapeRegExp(path)}(?=[\\s,.;:!?]|$)`, "g")
    let match: RegExpExecArray | null
    while ((match = pattern.exec(value))) {
      const start = match.index + match[1]!.length
      tokens.push({ start, end: start + path.length + 1, part: { type: "file_mention", path } })
    }
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
    const pattern = new RegExp(`(^|\\s)\\$${escapeRegExp(item.name)}(?=[\\s,.;:!?]|$)`, "gi")
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
    case "thread_reference":
      return formatThreadReference(part)
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

/**
 * The next free inline label for a new attachment: `image1`, `image2`, … for
 * images and `file1`, … for everything else. A label stays fixed while its
 * attachment is in the draft, so removing one never renumbers the others.
 */
export function nextAttachmentLabel(mediaType: string, taken: Iterable<string>): string {
  const prefix = mediaType.startsWith("image/") ? "image" : "file"
  const used = new Set(taken)
  let index = 1
  while (used.has(`${prefix}${index}`)) index++
  return `${prefix}${index}`
}
