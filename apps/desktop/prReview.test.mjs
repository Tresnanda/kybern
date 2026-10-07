import assert from "node:assert/strict"
import test from "node:test"

import { afterReviewSubmission, emptyReviewDraft, readReviewDraft, repairReviewPrompt, selectedReviewFindings, submitReviewDraft, toggleReviewFinding } from "./src/state/prReviewModel.ts"

const inline = { path: "src/a.rs", line: 7, side: "RIGHT", body: "Keep this check" }
const finding = { id: 13, author: "reviewer", body: "Handle this error", state: "CHANGES_REQUESTED", path: "src/a.rs", line: 7, side: "RIGHT", url: "https://github.com/example/repo/pull/1", updated_at: "2026-10-07" }

test("failed submissions keep the exact summary, inline draft, selected findings and repair identity", async () => {
  const draft = { ...emptyReviewDraft(), body: "Request summary", inline: [inline], pendingInline: { ...inline, line: 9, body: "Still typing" }, threadId: "repair-thread" }
  const selected = toggleReviewFinding(draft, "review_comments:13", finding)
  let saves = 0
  await assert.rejects(submitReviewDraft(selected, async () => { throw new Error("GitHub unavailable") }, () => selected, () => { saves++ }))
  assert.equal(saves, 0)
  assert.deepEqual(selectedReviewFindings(selected), [finding])
  assert.equal(selected.body, "Request summary")
  assert.equal(selected.pendingInline.body, "Still typing")
  assert.equal(selected.threadId, "repair-thread")
})

test("a slow successful submission keeps edits made during the request", async () => {
  const submitted = { ...emptyReviewDraft(), body: "Sent summary", inline: [inline] }
  const newer = { ...submitted, body: "Next summary", inline: [inline, { ...inline, line: 12, body: "New finding" }] }
  let result
  await submitReviewDraft(submitted, async () => {}, () => newer, (draft) => { result = draft })
  assert.equal(result.body, "Next summary")
  assert.deepEqual(result.inline, [newer.inline[1]])
  assert.deepEqual(submitted.inline, [inline], "the sent snapshot remains immutable")
})

test("successful review removes submitted content and keeps repair selection and unfinished inline editor", () => {
  const submitted = toggleReviewFinding({ ...emptyReviewDraft(), body: "Summary", inline: [inline], pendingInline: { ...inline, body: "Unfinished" } }, "review_comments:13", finding)
  const cleared = afterReviewSubmission(submitted, submitted)
  assert.equal(cleared.body, "")
  assert.deepEqual(cleared.inline, [])
  assert.equal(cleared.pendingInline.body, "Unfinished")
  assert.deepEqual(selectedReviewFindings(cleared), [finding])
})

test("selected findings stay available when paging and matching IDs from different review surfaces do not collide", () => {
  const one = toggleReviewFinding(emptyReviewDraft(), "reviews:13", { ...finding, body: "Review summary" })
  const two = toggleReviewFinding(one, "review_comments:13", finding)
  assert.equal(selectedReviewFindings(two).length, 2)
  const deselected = toggleReviewFinding(two, "reviews:13", finding)
  assert.deepEqual(selectedReviewFindings(deselected), [finding])
  assert.equal(deselected.findings["reviews:13"], undefined)
})

test("persistent draft roundtrip preserves LEFT anchors and rejects malformed stored values", () => {
  const draft = { ...emptyReviewDraft(), inline: [{ ...inline, side: "LEFT" }], pendingInline: inline, body: "Local draft", threadId: "existing-repair" }
  assert.deepEqual(readReviewDraft(JSON.parse(JSON.stringify(draft))), draft)
  const malformed = readReviewDraft({ body: 42, inline: [{ ...inline, line: -1 }, { ...inline, side: "WRONG" }], selected: "oops", pendingInline: null })
  assert.deepEqual(malformed, emptyReviewDraft())
})

test("repair prompt carries the reviewed head and rejects oversized findings without clipping source", () => {
  const draft = toggleReviewFinding(emptyReviewDraft(), "review_comments:13", finding)
  const prompt = repairReviewPrompt(1, "Repair flow", finding.url, "head-sha", draft)
  assert.ok(prompt.includes("Reviewed head: head-sha"))
  assert.ok(prompt.includes("Handle this error"))
  assert.ok(prompt.includes("Leave publishing reviews, closing and merging to the human"))
  const huge = { ...draft, inline: [{ ...inline, body: "é".repeat(40000) }] }
  assert.throws(() => repairReviewPrompt(1, "Repair flow", finding.url, "head-sha", huge), /Select fewer findings/)
  assert.equal(huge.inline[0].body.length, 40000, "nothing was truncated")
})
