import assert from "node:assert/strict"
import test from "node:test"

import { classifyPrError, reviewOverviewCache, reviewWorkspaceKind, afterReviewSubmission, bindReviewDraft, clearReviewDraft, emptyReviewDraft, readReviewDraft, repairReviewPrompt, reuseReviewDraftText, reviewDraftIsStale, selectedReviewFindings, submitReviewDraft, toggleReviewFinding } from "./src/state/prReviewModel.ts"

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

test("refreshing head A to B keeps text and inline anchors but blocks publication against B", async () => {
  const original = bindReviewDraft(
    emptyReviewDraft(),
    { body: "Review of A", inline: [inline] },
    "head-A"
  )
  const persisted = readReviewDraft(JSON.parse(JSON.stringify(original)))
  assert.equal(persisted.sourceHead, "head-A")
  assert.equal(reviewDraftIsStale(persisted, "head-B"), true)
  let published = false
  let saved = false
  await assert.rejects(
    submitReviewDraft(
      persisted,
      async () => {
        published = true
      },
      () => persisted,
      () => {
        saved = true
      },
      "head-B"
    ),
    /different commit/
  )
  assert.equal(published, false)
  assert.equal(saved, false)
  assert.deepEqual(
    persisted,
    original,
    "refresh and failed submission preserve the complete draft"
  )
  const edited = bindReviewDraft(
    persisted,
    { body: "Still reviewing A" },
    "head-B"
  )
  assert.equal(
    edited.sourceHead,
    "head-A",
    "typing never silently rebinds an old review"
  )
})

test("inline anchors cannot be reused automatically on a different head", () => {
  const original = bindReviewDraft(
    emptyReviewDraft(),
    { body: "Keep my text", inline: [inline] },
    "head-A"
  )
  assert.throws(
    () => reuseReviewDraftText(original, "head-B"),
    /Remove old inline drafts/
  )
  assert.deepEqual(original.inline, [inline])
  assert.equal(original.body, "Keep my text")
  const pending = { ...original, inline: [], pendingInline: inline }
  assert.throws(
    () => reuseReviewDraftText(pending, "head-B"),
    /unfinished editor/
  )
})

test("explicit text reuse keeps the summary and permits a review of the current commit", async () => {
  const original = bindReviewDraft(
    emptyReviewDraft(),
    { body: "Keep my text" },
    "head-A"
  )
  const current = reuseReviewDraftText(original, "head-B")
  assert.equal(current.body, original.body)
  assert.equal(current.sourceHead, "head-B")
  assert.equal(reviewDraftIsStale(current, "head-B"), false)
  let published = false
  await submitReviewDraft(
    current,
    async () => {
      published = true
    },
    () => current,
    () => {},
    "head-B"
  )
  assert.equal(published, true)
  assert.equal(
    original.sourceHead,
    "head-A",
    "explicit reuse does not mutate the prior draft"
  )
})

test("explicit clearing allows newly anchored comments against B and preserves repair selection", () => {
  const original = toggleReviewFinding(
    bindReviewDraft(
      emptyReviewDraft(),
      { body: "Old summary", inline: [inline] },
      "head-A"
    ),
    "review_comments:13",
    finding
  )
  const cleared = clearReviewDraft(original)
  assert.equal(cleared.body, "")
  assert.deepEqual(cleared.inline, [])
  assert.deepEqual(selectedReviewFindings(cleared), [finding])
  const fresh = bindReviewDraft(
    cleared,
    { pendingInline: { ...inline, line: 12, body: "Comment on B" } },
    "head-B"
  )
  assert.equal(fresh.sourceHead, "head-B")
  assert.equal(reviewDraftIsStale(fresh, "head-B"), false)
})

test("legacy stored text cannot acquire a current head merely by being loaded or edited", () => {
  const legacy = readReviewDraft({
    body: "Old saved summary",
    inline: [inline],
  })
  assert.equal(legacy.sourceHead, null)
  assert.equal(reviewDraftIsStale(legacy, "head-B"), true)
  const edited = bindReviewDraft(
    legacy,
    { body: "Edited old summary" },
    "head-B"
  )
  assert.equal(edited.sourceHead, null)
  assert.equal(reviewDraftIsStale(edited, "head-B"), true)
})


test("overview refresh retains same-head pages and invalidates changed-head line anchors without changing drafts", () => {
  const page = { files: [{ path: "src/reviews/submission.ts" }], entries: [], checks: [], page: 2, has_more: true }
  const draft = bindReviewDraft(emptyReviewDraft(), { body: "Keep review of A", inline: [inline] }, "head-A")
  const original = structuredClone(draft)
  const unchanged = reviewOverviewCache("head-A", "head-A", page, page.files[0].path)
  assert.equal(unchanged.page, page, "same-head reading page stays stable")
  assert.equal(unchanged.page.page, 2)
  assert.deepEqual(reviewOverviewCache("head-A", "head-B", page, page.files[0].path), { page: null, file: null }, "new head requires a freshly fetched file page")
  assert.deepEqual(reviewOverviewCache(null, "head-B", page, page.files[0].path), { page: null, file: null }, "an evicted detail cannot prove page ownership")
  assert.deepEqual(draft, original)
  assert.equal(reviewDraftIsStale(draft, "head-B"), true)
})

test("workspace navigation keeps paged conversation sources separate and directs Changes to files", () => {
  assert.equal(reviewWorkspaceKind("overview", "review_comments"), "review_comments", "overview does not reset a conversation page's source")
  assert.equal(reviewWorkspaceKind("changes", "checks"), "files")
  assert.equal(reviewWorkspaceKind("conversation", "files"), "comments")
  assert.equal(reviewWorkspaceKind("conversation", "reviews"), "reviews", "returning preserves the chosen review stream")
  assert.equal(reviewWorkspaceKind("conversation", "review_comments"), "review_comments")
})

import { checkBucket, checksPhrase, sortChecks, summarizeChecks } from "./src/views/pullRequests/prChecks.ts"
import { resolvePrStateKind } from "./src/views/pullRequests/prStateKind.ts"
import { ringSegments } from "./src/views/pullRequests/prChecks.ts"
import { truncateMiddle } from "./src/lib/truncate.ts"

const chk = (status, conclusion, name = "c") => ({ name, status, conclusion, url: "" })
test("check buckets follow the daemon rule for runs and legacy contexts", () => {
  assert.equal(checkBucket(chk("IN_PROGRESS", "")), "pending")
  assert.equal(checkBucket(chk("COMPLETED", "SUCCESS")), "passed")
  assert.equal(checkBucket(chk("COMPLETED", "TIMED_OUT")), "failed")
  assert.equal(checkBucket(chk("COMPLETED", "NEUTRAL")), "skipped")
  assert.equal(checkBucket(chk("pending", "pending")), "pending")
  assert.equal(checkBucket(chk("success", "success")), "passed")
  assert.equal(checkBucket(chk("failure", "failure")), "failed")
})

test("checks sort failing first and read as a phrase", () => {
  const list = [chk("COMPLETED", "SUCCESS", "a"), chk("IN_PROGRESS", "", "b"), chk("COMPLETED", "FAILURE", "c"), chk("COMPLETED", "SKIPPED", "d")]
  assert.deepEqual(sortChecks(list).map((c) => c.name), ["c", "b", "a", "d"])
  assert.equal(checksPhrase(summarizeChecks(list)), "1 failing · 1 running · 1 passed · 1 skipped")
  assert.equal(checksPhrase({ total: 14, passed: 14, failed: 0, pending: 0, skipped: 0 }), "All 14 passed")
  assert.equal(checksPhrase(undefined), "No checks reported")
})

test("ring arcs are proportional with 2-unit gaps", () => {
  const segs = ringSegments({ total: 10, passed: 6, failed: 2, pending: 2, skipped: 0 }, 100)
  assert.deepEqual(segs.map((s) => s.bucket), ["failed", "pending", "passed"])
  const usable = 100 - 6
  assert.ok(Math.abs(segs[2].length - 0.6 * usable) < 1e-9)
  assert.ok(Math.abs(segs[1].offset - (segs[0].length + 2)) < 1e-9)
})

test("pull request state precedence is merged, closed, draft, conflicts, open", () => {
  const pr = (state, is_draft, mergeable) => ({ state, is_draft, mergeable })
  assert.equal(resolvePrStateKind(pr("MERGED", true, "CONFLICTING")), "merged")
  assert.equal(resolvePrStateKind(pr("CLOSED", true, "CONFLICTING")), "closed")
  assert.equal(resolvePrStateKind(pr("OPEN", true, "CONFLICTING")), "draft")
  assert.equal(resolvePrStateKind(pr("OPEN", false, "CONFLICTING")), "conflicts")
  assert.equal(resolvePrStateKind(pr("OPEN", false, "MERGEABLE"), "DIRTY"), "conflicts")
  assert.equal(resolvePrStateKind(pr("OPEN", false, "MERGEABLE")), "open")
})

test("daemon errors are classified by the recovery they need", () => {
  assert.equal(classifyPrError("run gh: No such file or directory (os error 2)"), "gh-missing")
  assert.equal(classifyPrError("gh: not found"), "gh-missing")
  assert.equal(classifyPrError("To get started with GitHub CLI, please run: gh auth login"), "gh-auth")
  assert.equal(classifyPrError("HTTP 401: Bad credentials"), "gh-auth")
  assert.equal(classifyPrError("no git remotes found"), "no-remote")
  assert.equal(classifyPrError("rate limited"), "other")
})

test("truncateMiddle keeps both ends and leaves short text alone", () => {
  assert.equal(truncateMiddle("short", 32), "short")
  const out = truncateMiddle("feat/ui-rework-ade-30-33-with-a-very-long-name", 20)
  assert.equal([...out].length, 20)
  assert.ok(out.startsWith("feat/ui-re") && out.endsWith("long-name") && out.includes("…"))
})
