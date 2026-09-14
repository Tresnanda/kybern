export interface ReleasePresentation {
  title: string
  summary: string
  notes: string | null
  url: string
}

const TITLE_LIMIT = 80
const SUMMARY_LIMIT = 180

function truncate(value: string, limit: number) {
  const characters = Array.from(value)
  if (characters.length <= limit) return value

  const prefix = characters.slice(0, limit - 1).join("")
  const lastSpace = prefix.lastIndexOf(" ")
  const cut =
    lastSpace >= Math.floor(limit * 0.6) ? prefix.slice(0, lastSpace) : prefix
  return `${cut.trimEnd()}…`
}

function plainText(markdown: string) {
  return markdown
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<https?:\/\/[^>]+>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/[`*_~]/g, "")
    .replace(/^\s{0,3}(?:#{1,6}\s+|[-+*]\s+|\d+[.)]\s+)/, "")
    .replace(/\s+/g, " ")
    .trim()
}

function metadata(notes: string, key: "title" | "summary") {
  // Optional authoring convention:
  // <!-- kybern-release-title: A short headline -->
  // <!-- kybern-release-summary: One concrete sentence about the release -->
  const match = notes.match(
    new RegExp(`<!--\\s*kybern-release-${key}\\s*:\\s*([\\s\\S]*?)-->`, "i")
  )
  return match ? plainText(match[1]) : ""
}

function contentLines(notes: string) {
  return notes
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/```[\s\S]*?```/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function displayNotes(notes: string) {
  return notes.replace(/<!--[\s\S]*?-->/g, "").trim() || null
}

function isGenericHeading(value: string) {
  return /^(?:what(?:'|\u2019)?s (?:new|changed)|changes|changelog|release notes|new contributors)$/i.test(
    value
  )
}

function isDistributionHeading(value: string) {
  return /^(?:(?:install|download) kybern\b|install prebuilt binaries\b|android preview$)/i.test(
    value
  )
}

function isSummaryLine(value: string) {
  return (
    value.length > 0 &&
    !/^full changelog\s*:/i.test(value) &&
    !/^\|?(?:\s*:?-+:?\s*\|)+$/i.test(value) &&
    !/^\|/.test(value)
  )
}

function isLinkOnly(notes: string) {
  const remainder = plainText(notes)
    .replace(/release notes\s*:?/gi, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[\s:|\-\u2013\u2014]+/g, "")
  return remainder.length === 0
}

/** Turn the updater's raw GitHub release body into bounded announcement copy. */
export function releasePresentation(
  version: string,
  notes: string | null
): ReleasePresentation {
  const normalizedVersion = version.trim().replace(/^v(?=\d)/i, "") || "unknown"
  const displayVersion =
    normalizedVersion === "unknown" ? "" : ` ${normalizedVersion}`
  const fallbackTitle = `Kybern${displayVersion} is available`
  const fallbackSummary = "See what changed in this release."
  const url = `https://github.com/Tresnanda/kybern/releases/tag/v${encodeURIComponent(normalizedVersion)}`

  if (!notes?.trim() || isLinkOnly(notes)) {
    return { title: fallbackTitle, summary: fallbackSummary, notes: null, url }
  }

  const lines = contentLines(notes)
  const authoredTitle = metadata(notes, "title")
  const headings = lines.filter((line) => /^#{1,6}\s+/.test(line))
  const featureHeadingIndex = lines.findIndex((line) => {
    if (!/^#{1,6}\s+/.test(line)) return false
    const heading = plainText(line)
    return isGenericHeading(heading) || !isDistributionHeading(heading)
  })
  const heading = headings
    .map(plainText)
    .find(
      (line) => line && !isGenericHeading(line) && !isDistributionHeading(line)
    )
  const title = truncate(authoredTitle || heading || fallbackTitle, TITLE_LIMIT)

  const authoredSummary = metadata(notes, "summary")
  const summaryCandidates =
    featureHeadingIndex >= 0
      ? lines.slice(featureHeadingIndex + 1)
      : headings.length === 0
        ? lines
        : []
  const summaryLine = summaryCandidates
    .filter((line) => !/^#{1,6}\s+/.test(line))
    .map(plainText)
    .find((line) => isSummaryLine(line) && line !== title)
  const summary = truncate(
    authoredSummary || summaryLine || fallbackSummary,
    SUMMARY_LIMIT
  )

  return { title, summary, notes: displayNotes(notes), url }
}
