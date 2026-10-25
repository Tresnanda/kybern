// A Coordinator context refresh as both clients say it: the one-line row in the transcript, the
// meta line over the handoff, and the handoff itself split into its sections.
import type { Block } from "./transcript.ts"
import { PROVIDER_DISPLAY_NAME, type HarnessRef, type RotationCarried } from "./types.ts"

export type RotationBlock = Extract<Block, { kind: "rotation" }>

export const ROTATION_COPY = {
  pending: "Refreshing context…",
  sheetTitle: "Handoff",
  edited: "Edited by you",
  noHandoff:
    "The new session started from Kybern's facts and the recent messages, and can read older history in this thread.",
  noHandoffWhy: "The previous session didn't write a handoff.",
  noSections: "None",
} as const

const plural = (count: number, one: string, other = `${one}s`) => `${count} ${count === 1 ? one : other}`

const harnessName = (ref: HarnessRef | null) => (ref ? PROVIDER_DISPLAY_NAME[ref.kind] ?? ref.kind : null)

/** "201000" reads "201k"; small counts stay exact. */
export function tokenCount(tokens: number) {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(Math.max(0, Math.round(tokens)))
}

/** The handoff never made it: the daemon found nothing usable (a harness switch from a signed-out harness included). */
export const rotationMissingHandoff = (block: RotationBlock) => block.handoffStatus?.status === "missing"

/**
 * The row's one line. `formatTime` is the client's own clock convention, so a phone and a desktop
 * can each print their locale's time.
 */
export function rotationLabel(block: RotationBlock, formatTime: (date: Date) => string): string {
  if (block.pending) return ROTATION_COPY.pending
  if (block.reason === "harness_switch") {
    const name = harnessName(block.to)
    return `${name ? `Switched to ${name}` : "Switched harness"} · context carried`
  }
  const at = new Date(block.at)
  const time = Number.isNaN(at.getTime()) ? "" : ` · ${formatTime(at)}`
  if (rotationMissingHandoff(block)) return `Context refreshed without a handoff${time}`
  return `${block.reason === "manual" ? "Context refreshed by you" : "Context refreshed"}${time}`
}

/** "carried 3 agents, 1 pull request, 5 commits": nothing for a count of zero. */
export function carriedText(carried: RotationCarried) {
  const parts = [
    carried.children ? plural(carried.children, "agent") : "",
    carried.pull_requests ? plural(carried.pull_requests, "pull request") : "",
    carried.tasks ? plural(carried.tasks, "task") : "",
    carried.commits ? plural(carried.commits, "commit") : "",
  ].filter(Boolean)
  return parts.join(", ")
}

/** Why the session was replaced, phrased for the reason. Empty when the block has nothing to say. */
function reasonText(block: RotationBlock) {
  const used = block.usedTokens > 0 ? `${tokenCount(block.usedTokens)} tokens` : ""
  switch (block.reason) {
    case "budget":
      return used ? `Passed ${used}` : "Passed the context budget"
    case "idle":
      return used ? `Idle with ${used} used` : "Idle for a while"
    case "manual":
      return used ? `Refreshed by you at ${used}` : "Refreshed by you"
    case "harness_switch": {
      const from = harnessName(block.from)
      const to = harnessName(block.to)
      return from && to && from !== to ? `Moved from ${from} to ${to}` : to ? `Moved to ${to}` : "Moved to another harness"
    }
  }
}

/** The line under the sheet title: "Passed 200k tokens · carried 3 agents, 1 pull request, 5 commits". */
export function rotationMeta(block: RotationBlock): string {
  const carried = block.carried ? carriedText(block.carried) : ""
  const parts = [reasonText(block)]
  if (block.carried) {
    // The recent messages always travel with the facts; say so when nothing else did or the handoff is absent.
    const tail = rotationMissingHandoff(block) || !carried ? "the recent messages" : ""
    parts.push(`carried ${[carried, tail].filter(Boolean).join(carried && tail ? " and " : "")}`)
  }
  return parts.filter(Boolean).join(" · ")
}

export interface HandoffSection {
  /** The heading without its parenthetical hint: "Decisions (date, what, why)" reads "Decisions". */
  heading: string
  body: string
}

/** Splits `## Heading` sections. Text without headings (a hand-written edit) is one untitled section. */
export function handoffSections(text: string | null): HandoffSection[] {
  const source = (text ?? "").trim()
  if (!source) return []
  if (!/^## /m.test(source)) return [{ heading: "", body: source }]
  return source
    .split(/^## /m)
    .filter((chunk) => chunk.trim())
    .map((chunk) => {
      const [first = "", ...rest] = chunk.split("\n")
      return {
        heading: first.replace(/\s*\([^)]*\)\s*$/, "").trim(),
        body: rest.join("\n").trim() || ROTATION_COPY.noSections,
      }
    })
}

/** What a missing handoff says: the daemon's reason, then what the new session started from. */
export function missingHandoffText(block: RotationBlock) {
  const why = block.handoffStatus?.status === "missing" ? block.handoffStatus.why.trim() : ""
  return `${why || ROTATION_COPY.noHandoffWhy} ${ROTATION_COPY.noHandoff}`
}
