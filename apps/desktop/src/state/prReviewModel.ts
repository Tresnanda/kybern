import type { PrInlineComment, PrReviewEntry } from "../../../../packages/kybern-client/src/types.ts"

export interface ReviewDraft {
  body: string
  inline: PrInlineComment[]
  pendingInline: PrInlineComment | null
  selected: string[]
  findings: Record<string, PrReviewEntry>
  threadId: string | null
}
export const emptyReviewDraft = (): ReviewDraft => ({ body: "", inline: [], pendingInline: null, selected: [], findings: {}, threadId: null })

/** A successful submission removes only the exact content that was sent.
 * Typing during a slow request must remain a new draft; failure changes nothing. */
export function afterReviewSubmission(current: ReviewDraft, submitted: ReviewDraft): ReviewDraft {
  const sent = new Set(submitted.inline.map((comment) => JSON.stringify(comment)))
  return { ...current, body: current.body === submitted.body ? "" : current.body, inline: current.inline.filter((comment) => !sent.has(JSON.stringify(comment))) }
}
export async function submitReviewDraft(submitted: ReviewDraft, publish: () => Promise<unknown>, read: () => ReviewDraft, save: (draft: ReviewDraft) => void) {
  await publish()
  save(afterReviewSubmission(read(), submitted))
}

export function selectedReviewFindings(draft: ReviewDraft): PrReviewEntry[] {
  return draft.selected.map((id) => draft.findings[id]).filter((entry): entry is PrReviewEntry => !!entry)
}
export function toggleReviewFinding(draft: ReviewDraft, id: string, entry: PrReviewEntry): ReviewDraft {
  if (!draft.selected.includes(id) && draft.selected.length >= 100) return draft
  const selected = draft.selected.includes(id) ? draft.selected.filter((value) => value !== id) : [...draft.selected, id]
  const findings = { ...draft.findings }
  if (selected.includes(id)) findings[id] = entry
  else delete findings[id]
  return { ...draft, selected, findings }
}

/** Loading a local draft treats malformed data as absent, never as executable input. */
export function readReviewDraft(value: unknown): ReviewDraft {
  if (!value || typeof value !== "object") return emptyReviewDraft()
  const draft = value as Partial<ReviewDraft>
  const validComment = (comment: unknown): comment is PrInlineComment => {
    if (!comment || typeof comment !== "object") return false
    const c = comment as PrInlineComment
    return typeof c.path === "string" && Number.isInteger(c.line) && c.line > 0 && (c.side === "LEFT" || c.side === "RIGHT") && typeof c.body === "string" && c.body.length <= 65536
  }
  const findings: Record<string, PrReviewEntry> = {}
  const selected: string[] = []
  for (const id of Array.isArray(draft.selected) ? draft.selected.slice(0, 100) : []) {
    const entry = draft.findings?.[id]
    if (typeof id === "string" && entry && typeof entry.body === "string" && typeof entry.author === "string" && entry.body.length <= 65536) {
      findings[id] = entry; selected.push(id)
    }
  }
  return { body: typeof draft.body === "string" ? draft.body.slice(0, 65536) : "", inline: Array.isArray(draft.inline) ? draft.inline.filter(validComment).slice(0, 100) : [], pendingInline: validComment(draft.pendingInline) ? draft.pendingInline : null, selected, findings, threadId: typeof draft.threadId === "string" ? draft.threadId : null }
}

export function repairReviewPrompt(number: number, title: string, url: string, head: string, draft: ReviewDraft): string {
  const findings = [...selectedReviewFindings(draft).map((entry) => `${entry.path ? `${entry.path}:${entry.line ?? "?"} (${entry.side ?? "RIGHT"})` : `Review by ${entry.author}`}\n${entry.body}`), ...draft.inline.map((entry) => `${entry.path}:${entry.line} (${entry.side})\n${entry.body}`)]
  const body = `Repair pull request #${number}: ${title}\n${url}\nReviewed head: ${head}\n\nAddress these selected review findings and verify the changes:\n\n${findings.join("\n\n")}\n\nKeep the repair on this pull request’s branch. Report the changes and validation. Leave publishing reviews, closing and merging to the human.`
  if (new TextEncoder().encode(body).byteLength > 64 * 1024) throw new Error("These findings exceed the 64 KiB repair limit. Select fewer findings or shorten your inline drafts, then send again.")
  return body
}
