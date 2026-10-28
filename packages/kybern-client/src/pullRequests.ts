// Pull requests: the state a pull request is in, how its checks read, list filtering and the
// conversations a checkout or repair can use. Pure; shared by desktop, GPUIX and mobile so a
// pull request reads the same everywhere. (State and check rules moved from desktop
// views/pullRequests/prStateKind.ts and prChecks.ts.)
import type { MergeMethod, PrCheck, PrChecksSummary, PrDetailResult, PullRequest, Thread } from "./types.ts";

export type PrStateKind = "open" | "draft" | "conflicts" | "merged" | "closed";

type StateInput = Pick<PullRequest, "state" | "is_draft" | "mergeable">;

/** Precedence: merged > closed > draft > conflicts > open. */
export function resolvePrStateKind(pr: StateInput, mergeStateStatus?: string | null): PrStateKind {
  const state = pr.state.toUpperCase();
  if (state === "MERGED") return "merged";
  if (state === "CLOSED") return "closed";
  if (pr.is_draft) return "draft";
  if (pr.mergeable === "CONFLICTING" || mergeStateStatus === "DIRTY") return "conflicts";
  return "open";
}

/** The word beside the state glyph. */
export const PR_STATE_WORDS: Record<PrStateKind, string> = {
  open: "Open",
  draft: "Draft",
  conflicts: "Has conflicts",
  merged: "Merged",
  closed: "Closed",
};

/** "Approved", "Changes requested", "Review required"; empty when GitHub gave no decision. */
export function reviewDecisionWord(decision: string | null | undefined): string {
  switch ((decision ?? "").toUpperCase()) {
    case "APPROVED":
      return "Approved";
    case "CHANGES_REQUESTED":
      return "Changes requested";
    case "REVIEW_REQUIRED":
      return "Review required";
    default:
      return "";
  }
}

// ---- checks ----

export type CheckBucket = "passed" | "failed" | "pending" | "skipped";

const FAILED = ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"];

/** Same rule as the daemon's `check_bucket`. Paged checks carry lower-case values. */
export function checkBucket(check: PrCheck): CheckBucket {
  const status = check.status.toUpperCase();
  const conclusion = check.conclusion.toUpperCase();
  // A StatusContext reports its state in both fields.
  if (["PENDING", "EXPECTED"].includes(conclusion)) return "pending";
  if (status && status !== "COMPLETED" && !["SUCCESS", "FAILURE", "ERROR"].includes(status)) return "pending";
  if (conclusion === "SUCCESS") return "passed";
  if (FAILED.includes(conclusion)) return "failed";
  return "skipped";
}

export function summarizeChecks(checks: readonly PrCheck[]): PrChecksSummary {
  const out: PrChecksSummary = { total: checks.length, passed: 0, failed: 0, pending: 0, skipped: 0 };
  for (const check of checks) out[checkBucket(check)]++;
  return out;
}

const ORDER: Record<CheckBucket, number> = { failed: 0, pending: 1, passed: 2, skipped: 3 };
/** Failing first, then running, passed and skipped; the original order within a bucket. */
export function sortChecks(checks: readonly PrCheck[]): PrCheck[] {
  return checks
    .map((check, index) => ({ check, index, rank: ORDER[checkBucket(check)] }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.check);
}

export function checksPhrase(summary: PrChecksSummary | null | undefined): string {
  if (!summary || summary.total === 0) return "No checks reported";
  if (summary.passed === summary.total) return `All ${summary.total} passed`;
  const parts: string[] = [];
  if (summary.failed) parts.push(`${summary.failed} failing`);
  if (summary.pending) parts.push(`${summary.pending} running`);
  if (summary.passed) parts.push(`${summary.passed} passed`);
  if (summary.skipped) parts.push(`${summary.skipped} skipped`);
  return parts.join(" · ");
}

/** Accessible label for the list's CI dot, e.g. "Checks: 2 failing of 14". */
export function checksDotLabel(summary: PrChecksSummary): string {
  if (summary.failed) return `Checks: ${summary.failed} failing of ${summary.total}`;
  if (summary.pending) return `Checks: ${summary.pending} running of ${summary.total}`;
  if (summary.skipped) return `Checks: ${summary.passed} passed, ${summary.skipped} skipped`;
  return `Checks: all ${summary.total} passed`;
}

/** The one bucket a summary reads as: any failure fails, else anything running is pending. */
export function checksOutcome(summary: PrChecksSummary | null | undefined): CheckBucket | null {
  if (!summary || summary.total === 0) return null;
  if (summary.failed) return "failed";
  if (summary.pending) return "pending";
  if (summary.passed) return "passed";
  return "skipped";
}

/** Arc lengths for the ring, proportional to each bucket with a 2-unit gap between segments. */
export function ringSegments(summary: PrChecksSummary, circumference: number, gap = 2) {
  const order = ["failed", "pending", "passed", "skipped"] as const;
  const buckets = order.filter((b) => summary[b] > 0);
  const gaps = buckets.length > 1 ? gap : 0;
  const usable = circumference - gaps * buckets.length;
  let offset = 0;
  return buckets.map((bucket) => {
    const length = (summary[bucket] / summary.total) * usable;
    const segment = { bucket, length, offset };
    offset += length + gaps;
    return segment;
  });
}

// ---- check words, names and groups ----

/** "Failed", "Cancelled", "Timed out"… GitHub's conclusion in plain words; running and queued are told apart. */
export function checkWord(check: PrCheck): string {
  const status = check.status.toUpperCase();
  const conclusion = check.conclusion.toUpperCase();
  switch (checkBucket(check)) {
    case "passed":
      return "Passed";
    case "pending":
      if (!status) return "Pending"; // a commit status: its state is the conclusion
      return ["QUEUED", "WAITING", "PENDING", "REQUESTED"].includes(status) ? "Queued" : "Running";
    case "failed":
      switch (conclusion) {
        case "CANCELLED":
          return "Cancelled";
        case "TIMED_OUT":
          return "Timed out";
        case "ACTION_REQUIRED":
          return "Needs action";
        case "STARTUP_FAILURE":
          return "Failed to start";
        case "ERROR":
          return "Error";
        default:
          return "Failed";
      }
    default:
      switch (conclusion) {
        case "NEUTRAL":
          return "Neutral";
        case "STALE":
          return "Stale";
        default:
          return "Skipped";
      }
  }
}

/** A check name without emoji and pictographs (and the joiners that hold them together). */
export function cleanCheckName(name: string): string {
  const cleaned = name
    .replace(/[\p{Extended_Pictographic}‍︎️⃣]/gu, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return cleaned || name.trim();
}

/** "45s", "3m 12s", "1h 4m". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export interface CheckGroup {
  /** Stable row key. */
  key: string;
  /** The job name without its matrix suffix and emoji: "Tests". */
  label: string;
  workflow?: string;
  /** The worst bucket among its checks: failed, then running, then passed, then skipped. */
  bucket: CheckBucket;
  /** Any shard is required by the branch rules. */
  required: boolean;
  checks: PrCheck[];
  counts: PrChecksSummary;
  /** "shards 1/4 done · 1 failed" for a running sharded job, "1 of 4 shards failed" once it is done; the word ("Running", "Cancelled") for a lone check that is not green; "" otherwise. */
  detail: string;
  /** Wall-clock from the first shard's start to the last one's end (to now while running). */
  elapsedMs: number | null;
  elapsed: string;
  /** The link to open: the first failing shard, else the first. */
  url: string;
}

const GROUP_ORDER: CheckBucket[] = ["failed", "pending", "passed", "skipped"];

function baseName(name: string): string {
  const cleaned = cleanCheckName(name);
  const stripped = cleaned.replace(/\s*\([^()]*\)\s*$/, "").trim();
  return stripped || cleaned;
}

function time(value: string | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

/**
 * Checks folded into one row per job: the shards of a matrix ("Tests (1/4)"…) share a row, and
 * rows run failed → running → passed → skipped, keeping first-seen order inside each.
 */
export function groupChecks(checks: readonly PrCheck[], now: number = Date.now()): CheckGroup[] {
  const groups = new Map<string, PrCheck[]>();
  for (const check of checks) {
    const key = `${check.workflow_name ?? ""}::${baseName(check.name)}`;
    const list = groups.get(key);
    if (list) list.push(check);
    else groups.set(key, [check]);
  }
  const out: CheckGroup[] = [];
  for (const [key, members] of groups) {
    const counts = summarizeChecks(members);
    const bucket = GROUP_ORDER.find((b) => counts[b] > 0) ?? "skipped";
    const sharded = members.length > 1;
    const done = counts.total - counts.pending;
    let detail = "";
    if (sharded) {
      // A finished job only says what failed: "shards 4/4 done · 1 failed" wrapped mid-phrase in the 296 px sidebar.
      if (counts.pending === 0 && counts.failed) detail = `${counts.failed} of ${counts.total} shards failed`;
      else if (counts.pending === 0) detail = `${counts.total} shards`;
      else detail = `shards ${done}/${counts.total} done${counts.failed ? ` · ${counts.failed} failed` : ""}`;
    } else if (bucket !== "passed") {
      detail = checkWord(members[0]);
    }
    const starts = members.map((m) => time(m.started_at)).filter((t): t is number => t !== null);
    const ends = members.map((m) => time(m.completed_at));
    let elapsedMs: number | null = null;
    if (starts.length > 0) {
      const finished = counts.pending === 0 && ends.every((t) => t !== null);
      const end = finished ? Math.max(...(ends as number[])) : now;
      elapsedMs = Math.max(0, end - Math.min(...starts));
    }
    out.push({
      key,
      label: baseName(members[0].name),
      workflow: members[0].workflow_name,
      bucket,
      required: members.some((m) => m.is_required === true),
      checks: members,
      counts,
      detail,
      elapsedMs,
      elapsed: elapsedMs === null ? "" : formatDuration(elapsedMs),
      url: (members.find((m) => checkBucket(m) === "failed") ?? members[0]).url,
    });
  }
  const rank = (g: CheckGroup) => GROUP_ORDER.indexOf(g.bucket);
  return out.map((group, index) => ({ group, index })).sort((a, b) => rank(a.group) - rank(b.group) || a.index - b.index).map((e) => e.group);
}

// ---- the assessment ----

export type VerdictTone = "ready" | "waiting" | "blocked" | "conflict" | "draft" | "merged" | "closed" | "unknown";
/** How loudly to colour it: green, blue, amber, red or grey. */
export type VerdictSeverity = "success" | "info" | "warning" | "danger" | "neutral";
export type BlockerKind = "conflicts" | "behind" | "checks_failed" | "changes_requested" | "review_required" | "branch_protection";
export interface PrBlocker {
  kind: BlockerKind;
  label: string;
  severity: "warning" | "danger";
}
export type PrPrimaryKind =
  | "merge"
  | "auto_merge"
  | "cancel_auto_merge"
  | "update_branch"
  | "resolve_in_conversation"
  | "ready_for_review"
  | "none";
export type PrMenuKind = "merge" | "auto_merge" | "merge_admin" | "update_branch" | "cancel_auto_merge" | "close";
/** `method` rides with `merge` and `auto_merge`. */
export interface PrPrimaryAction {
  kind: PrPrimaryKind;
  label: string;
  method?: MergeMethod;
}
/** `method` rides with `merge`, `auto_merge` and `merge_admin`; `destructive` asks for a confirm and a red label. */
export interface PrMenuAction {
  kind: PrMenuKind;
  label: string;
  method?: MergeMethod;
  destructive?: boolean;
}
export interface PrAssessment {
  tone: VerdictTone;
  severity: VerdictSeverity;
  /** "Ready to merge", "Waiting on 6 checks", "2 blockers". */
  title: string;
  /** One or two sentences under the title. */
  detail: string;
  blockers: PrBlocker[];
  /** What to do about it, as a clause after "Next:"; null when nothing is needed. */
  next: string | null;
  primary: PrPrimaryAction;
  menu: PrMenuAction[];
  /** The answer is not settled (GitHub is still computing mergeability): fetch the pull request again in a moment. */
  refetch: boolean;
}

export type AssessInput = Pick<PrDetailResult, "pull_request"> &
  Partial<Pick<PrDetailResult, "checks" | "merge_state_status" | "reviews" | "viewer" | "behind_by" | "merged_by">>;

const KNOWN_STATES = ["CLEAN", "BLOCKED", "BEHIND", "DIRTY", "UNSTABLE", "DRAFT", "HAS_HOOKS"];
/** GitHub could merge now: nothing it requires is missing. `gh pr merge --auto` merges at once in these states, so auto-merge is never offered. */
const MERGEABLE_NOW = ["CLEAN", "HAS_HOOKS", "UNSTABLE"];
const METHOD_ORDER: MergeMethod[] = ["squash", "merge", "rebase"];
const METHOD_LABEL: Record<MergeMethod, string> = {
  squash: "Squash and merge",
  merge: "Create merge commit",
  rebase: "Rebase and merge",
};
const METHOD_VERB: Record<MergeMethod, string> = { squash: "squash and merge", merge: "merge", rebase: "rebase and merge" };
const METHOD_NEXT: Record<MergeMethod, string> = { squash: "squashes", merge: "merges", rebase: "rebases" };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

interface CheckFacts {
  total: number;
  passed: number;
  skipped: number;
  failed: number;
  pending: number;
  /** Failing or running checks that hold the merge up (required, or unknown when nothing is marked required). */
  failedBlocking: number;
  pendingBlocking: number;
  failedOptional: number;
  pendingOptional: number;
  /** There were individual checks to read, not only a summary. */
  detailed: boolean;
}

function checkFacts(input: AssessInput): CheckFacts {
  const checks = input.checks ?? [];
  if (checks.length === 0) {
    const s = input.pull_request.checks_summary;
    const base = s ?? { total: 0, passed: 0, failed: 0, pending: 0, skipped: 0 };
    return {
      ...base,
      failedBlocking: base.failed,
      pendingBlocking: base.pending,
      failedOptional: 0,
      pendingOptional: 0,
      detailed: false,
    };
  }
  // Failures and running checks block unless the rules name other checks as the required ones.
  const anyRequired = checks.some((c) => c.is_required === true);
  const facts: CheckFacts = {
    ...summarizeChecks(checks),
    failedBlocking: 0,
    pendingBlocking: 0,
    failedOptional: 0,
    pendingOptional: 0,
    detailed: true,
  };
  for (const check of checks) {
    const bucket = checkBucket(check);
    if (bucket !== "failed" && bucket !== "pending") continue;
    const blocking = !anyRequired || check.is_required !== false;
    if (bucket === "failed") blocking ? facts.failedBlocking++ : facts.failedOptional++;
    else blocking ? facts.pendingBlocking++ : facts.pendingOptional++;
  }
  return facts;
}

/** Minutes left on running checks, judged from how long their finished shards took. Null unless every running check can be judged. */
function estimateLeftMs(checks: readonly PrCheck[], now: number): number | null {
  const running = checks.filter((c) => checkBucket(c) === "pending");
  if (running.length === 0) return null;
  let left = 0;
  for (const check of running) {
    const started = time(check.started_at);
    if (started === null) return null;
    const durations = checks
      .filter((c) => c.workflow_name === check.workflow_name && checkBucket(c) !== "pending")
      .map((c) => {
        const a = time(c.started_at);
        const b = time(c.completed_at);
        return a !== null && b !== null && b >= a ? b - a : null;
      })
      .filter((d): d is number => d !== null);
    if (durations.length === 0) return null;
    left = Math.max(left, Math.max(...durations) - (now - started));
  }
  return left > 0 ? left : null;
}

function leftPhrase(ms: number | null): string | null {
  if (ms === null) return null;
  const minutes = Math.ceil(ms / 60_000);
  if (minutes <= 1) return "less than a minute left";
  if (minutes < 90) return `about ${minutes} min left`;
  return `about ${Math.round(minutes / 60)} h left`;
}

function passedSkipped(facts: CheckFacts): string[] {
  const parts: string[] = [];
  if (facts.passed) parts.push(`${facts.passed} passed`);
  if (facts.skipped) parts.push(`${facts.skipped} skipped`);
  return parts;
}

function optionalNotes(facts: CheckFacts): string[] {
  const notes: string[] = [];
  if (facts.failedOptional) notes.push(`${plural(facts.failedOptional, "optional check")} failed`);
  if (facts.pendingOptional) notes.push(`${plural(facts.pendingOptional, "optional check")} still running`);
  return notes;
}

function preferredMethod(input: AssessInput): { methods: MergeMethod[]; preferred: MergeMethod } {
  const allowed = input.viewer?.merge_methods ?? [];
  const methods = METHOD_ORDER.filter((m) => allowed.includes(m));
  const list = methods.length > 0 ? methods : (["squash"] as MergeMethod[]);
  return { methods: list, preferred: list[0] };
}

const NONE = (label: string): PrPrimaryAction => ({ kind: "none", label });

/** A merged or closed pull request: nothing left to do. */
function finished(tone: "merged" | "closed", title: string, detail: string): PrAssessment {
  return { tone, severity: "neutral", title, detail, blockers: [], next: null, primary: NONE(""), menu: [], refetch: false };
}

/**
 * The one reading of a pull request that the verdict card, the main action, the list reason and
 * the readiness group all share. Running checks are never "failing" and nothing is "ready" while
 * something blocks it or GitHub has not yet said whether it can merge.
 */
export function assessPullRequest(input: AssessInput, now: number = Date.now()): PrAssessment {
  const pr = input.pull_request;
  const state = pr.state.toUpperCase();
  const base = pr.base || "the base branch";
  const viewer = input.viewer;
  const close: PrMenuAction = { kind: "close", label: "Close pull request", destructive: true };

  if (state === "MERGED") {
    const by = input.merged_by ? `Merged by ${input.merged_by}.` : "This pull request was merged.";
    return finished("merged", `Merged into ${base}`, by);
  }
  if (state === "CLOSED") {
    return finished("closed", "Closed without merging", "Nobody merged this pull request.");
  }

  const mss = (input.merge_state_status ?? pr.merge_state_status ?? "").toUpperCase();
  const auto = pr.auto_merge ?? null;
  const facts = checkFacts(input);
  const { methods, preferred } = preferredMethod(input);

  if (pr.is_draft || mss === "DRAFT") {
    return {
      tone: "draft",
      severity: "neutral",
      title: "Draft",
      detail: "This pull request is a draft, so it can't merge yet.",
      blockers: [{ kind: "branch_protection", label: "It is still a draft", severity: "warning" }],
      next: "mark it ready for review when it is done",
      primary: viewer && !viewer.can_mark_ready ? NONE("Draft") : { kind: "ready_for_review", label: "Ready for review" },
      menu: [close],
      refetch: false,
    };
  }

  // ---- blockers, in the order they decide the next step ----
  const blockers: PrBlocker[] = [];
  const conflicts = pr.mergeable === "CONFLICTING" || mss === "DIRTY";
  const behind = mss === "BEHIND";
  if (conflicts) blockers.push({ kind: "conflicts", label: `Conflicts with ${base}`, severity: "danger" });
  if (behind) {
    const n = input.behind_by;
    blockers.push({
      kind: "behind",
      label: n ? `${plural(n, "commit")} behind ${base}` : `Behind ${base}`,
      severity: "warning",
    });
  }
  if (facts.failedBlocking > 0) {
    blockers.push({ kind: "checks_failed", label: `${plural(facts.failedBlocking, "check")} failed`, severity: "danger" });
  }
  const decision = (pr.review_decision ?? "").toUpperCase();
  if (decision === "CHANGES_REQUESTED") {
    const who = (input.reviews ?? []).filter((r) => r.state === "CHANGES_REQUESTED").map((r) => r.login);
    blockers.push({
      kind: "changes_requested",
      label: who.length > 0 ? `Changes requested by ${who.join(", ")}` : "Changes requested",
      severity: "danger",
    });
  } else if (decision === "REVIEW_REQUIRED") {
    blockers.push({ kind: "review_required", label: "Needs an approving review", severity: "warning" });
  }
  // GitHub says blocked and nothing above or below explains it: say so rather than call it ready.
  if (mss === "BLOCKED" && blockers.length === 0 && facts.pendingBlocking === 0) {
    blockers.push({ kind: "branch_protection", label: "Blocked by the branch rules", severity: "warning" });
  }

  const known = KNOWN_STATES.includes(mss);
  // UNSTABLE says something is not passing: with no non-passing check to point at, the data is stale.
  const unstableUnexplained = mss === "UNSTABLE" && facts.failed + facts.pending === 0;
  const unsettled = !known || unstableUnexplained;
  const left = leftPhrase(estimateLeftMs(input.checks ?? [], now));
  // UNSTABLE: what fails or runs is not required, so GitHub lets anyone who may merge do it now; no admin bypass is needed.
  const mergeableNow = MERGEABLE_NOW.includes(mss);
  const canMerge = viewer ? viewer.can_merge : true;
  const adminMenu: PrMenuAction[] =
    mergeableNow && canMerge
      ? [{ kind: "merge", label: "Merge anyway", method: preferred, destructive: true }]
      : viewer?.can_merge_as_admin && !conflicts
        ? [{ kind: "merge_admin", label: "Merge anyway", method: preferred, destructive: true }]
        : [];

  // ---- blocked ----
  if (blockers.length > 0) {
    const single = blockers.length === 1 ? blockers[0] : null;
    const title = single ? blockerTitle(single, base) : `${blockers.length} blockers`;
    const progress = [...passedSkipped(facts), ...(facts.pendingBlocking ? [`${facts.pendingBlocking} still running`] : []), ...optionalNotes(facts)];
    const ask = mergeableNow
      ? "None of this is required by the branch rules, so it can still merge."
      : `${blockers.length === 1 ? "Resolve this" : "Resolve these"} before it can merge.`;
    const detail = `${progress.length > 0 ? `${progress.join(" · ")}. ` : ""}${ask}`;
    const severity: VerdictSeverity = blockers.some((b) => b.severity === "danger") ? "danger" : "warning";
    const menu: PrMenuAction[] = [];
    let primary: PrPrimaryAction;
    if (conflicts) {
      primary = { kind: "resolve_in_conversation", label: "Resolve in conversation" };
    } else if (behind && viewer?.can_update_branch !== false) {
      primary = { kind: "update_branch", label: "Update branch" };
    } else {
      primary = NONE(severity === "danger" ? "Can't merge yet" : "Waiting on review");
    }
    if (behind && primary.kind !== "update_branch" && viewer?.can_update_branch !== false) {
      menu.push({ kind: "update_branch", label: "Update branch" });
    }
    if (auto && viewer?.can_disable_auto_merge !== false) menu.push({ kind: "cancel_auto_merge", label: "Cancel auto-merge" });
    menu.push(...adminMenu, close);
    return {
      tone: conflicts ? "conflict" : "blocked",
      severity,
      title,
      detail,
      blockers,
      next: nextStep(blockers[0], viewer?.can_merge_as_admin === true),
      primary,
      menu,
      refetch: false,
    };
  }

  // ---- armed auto-merge: GitHub will do the merge ----
  if (auto) {
    const by = auto.enabled_by ? ` Turned on by ${auto.enabled_by}.` : "";
    const verb = METHOD_VERB[(METHOD_ORDER as string[]).includes(auto.merge_method) ? (auto.merge_method as MergeMethod) : "squash"];
    const when =
      facts.pendingBlocking > 0
        ? `when ${facts.pendingBlocking === 1 ? "the check passes" : `the ${facts.pendingBlocking} checks pass`}`
        : "as soon as GitHub allows it";
    return {
      tone: "waiting",
      severity: "info",
      title: "Auto-merge is on",
      detail: `It will ${verb} ${when}.${by}`,
      blockers: [],
      next: null,
      primary: viewer?.can_disable_auto_merge === false ? NONE("Auto-merge is on") : { kind: "cancel_auto_merge", label: "Cancel auto-merge" },
      menu: [...adminMenu, close],
      refetch: false,
    };
  }

  // ---- GitHub has not settled mergeability ----
  if (unsettled && facts.pendingBlocking === 0) {
    return {
      tone: "unknown",
      severity: "neutral",
      title: "Checking whether it can merge",
      detail: "GitHub is still working this out. Refresh in a moment.",
      blockers: [],
      next: null,
      primary: NONE("Checking…"),
      menu: [close],
      refetch: true,
    };
  }

  // ---- waiting on checks ----
  if (facts.pendingBlocking > 0) {
    // Auto-merge waits only for required checks; with none required (UNSTABLE) GitHub would merge at once.
    const canArm = (viewer ? viewer.can_enable_auto_merge : true) && !mergeableNow;
    const parts = [...passedSkipped(facts), ...(left ? [left] : []), ...optionalNotes(facts)];
    return {
      tone: "waiting",
      severity: "warning",
      title: `Waiting on ${plural(facts.pendingBlocking, "check")}`,
      detail: `${parts.length > 0 ? `${parts.join(" · ")}. ` : ""}Nothing else blocks the merge.`,
      blockers: [],
      next: canArm
        ? `turn on auto-merge so it ${METHOD_NEXT[preferred]} when ${facts.pendingBlocking === 1 ? "the check passes" : "the checks pass"}`
        : mergeableNow && canMerge
          ? "wait for the checks to finish, or merge anyway from the menu"
          : null,
      primary: canArm ? { kind: "auto_merge", label: "Merge when ready", method: preferred } : NONE("Waiting on checks"),
      menu: [
        ...(canArm ? methods.slice(1).map((m): PrMenuAction => ({ kind: "auto_merge", label: `Merge when ready (${METHOD_LABEL[m].toLowerCase()})`, method: m })) : []),
        ...adminMenu,
        close,
      ],
      refetch: false,
    };
  }

  // ---- ready ----
  const parts = facts.total > 0 && facts.passed === facts.total ? [] : [...passedSkipped(facts), ...optionalNotes(facts)];
  const summary =
    facts.total === 0
      ? "No checks reported."
      : facts.passed === facts.total
        ? facts.total === 1
          ? "The check passed."
          : `All ${facts.total} checks passed.`
        : `${parts.join(" · ")}.`;
  return {
    tone: "ready",
    severity: "success",
    title: "Ready to merge",
    detail: `${summary} Nothing blocks the merge.`,
    blockers: [],
    next: null,
    primary: canMerge ? { kind: "merge", label: METHOD_LABEL[preferred], method: preferred } : NONE("You can't merge here"),
    menu: [...(canMerge ? methods.slice(1).map((m): PrMenuAction => ({ kind: "merge", label: METHOD_LABEL[m], method: m })) : []), close],
    refetch: false,
  };
}

function blockerTitle(b: PrBlocker, base: string): string {
  switch (b.kind) {
    case "conflicts":
      return `Conflicts with ${base}`;
    case "behind":
      return `Behind ${base}`;
    case "checks_failed":
      return b.label;
    case "changes_requested":
      return "Changes requested";
    case "review_required":
      return "Waiting on review";
    default:
      return "Blocked by the branch rules";
  }
}

function nextStep(first: PrBlocker, canBypass: boolean): string {
  switch (first.kind) {
    case "conflicts":
      return "have an agent resolve the conflicts in a conversation";
    case "behind":
      return "update the branch to pick up the latest changes";
    case "checks_failed":
      return "fix the failing checks, or ask an agent to";
    case "changes_requested":
      return "address the requested changes, then ask for another review";
    case "review_required":
      return canBypass ? "ask a reviewer to approve, or merge anyway as an admin" : "ask a reviewer to approve";
    default:
      return canBypass ? "check the branch rules, or merge anyway as an admin" : "check the branch rules";
  }
}

// ---- list rows ----

export type ReadinessGroup = "needs_attention" | "awaiting_review" | "approved" | "draft";
export const READINESS_GROUPS: readonly { value: ReadinessGroup; label: string }[] = [
  { value: "needs_attention", label: "Needs attention" },
  { value: "awaiting_review", label: "Awaiting review" },
  { value: "approved", label: "Approved" },
  { value: "draft", label: "Drafts" },
];

export interface RowReason {
  label: string;
  tone: "danger" | "warning" | "success" | "info" | "neutral";
}

type RowInput = Pick<
  PullRequest,
  "state" | "is_draft" | "mergeable" | "merge_state_status" | "review_decision" | "checks_summary" | "auto_merge" | "base"
>;

/** The short reason on a list row; "Conflicts", "2 failing", "Changes requested", "6 running", "Needs review", "Ready". */
export function rowReason(pr: RowInput): RowReason {
  const state = pr.state.toUpperCase();
  if (state === "MERGED") return { label: "Merged", tone: "neutral" };
  if (state === "CLOSED") return { label: "Closed", tone: "neutral" };
  if (pr.is_draft) return { label: "Draft", tone: "neutral" };
  const mss = (pr.merge_state_status ?? "").toUpperCase();
  if (pr.mergeable === "CONFLICTING" || mss === "DIRTY") return { label: "Conflicts", tone: "danger" };
  const checks = pr.checks_summary;
  if (checks && checks.failed > 0) return { label: `${checks.failed} failing`, tone: "danger" };
  const decision = (pr.review_decision ?? "").toUpperCase();
  if (decision === "CHANGES_REQUESTED") return { label: "Changes requested", tone: "danger" };
  if (mss === "BEHIND") return { label: "Behind", tone: "warning" };
  if (pr.auto_merge) return { label: "Auto-merge on", tone: "info" };
  if (checks && checks.pending > 0) return { label: `${checks.pending} running`, tone: "warning" };
  if (decision === "REVIEW_REQUIRED") return { label: "Needs review", tone: "neutral" };
  const mergeable = mss === "CLEAN" || mss === "HAS_HOOKS" || mss === "UNSTABLE";
  if (decision === "APPROVED") return mergeable ? { label: "Ready", tone: "success" } : mss === "BLOCKED" ? { label: "Blocked", tone: "warning" } : { label: "Approved", tone: "success" };
  if (mss === "CLEAN" || mss === "HAS_HOOKS") return { label: "Ready", tone: "success" };
  if (mss === "BLOCKED") return { label: "Blocked", tone: "warning" };
  return { label: "Open", tone: "neutral" };
}

/**
 * Where an open pull request sits in the list. Merged and closed pull requests are not grouped
 * (null). Without a required review a clean pull request counts as approved.
 */
export function readinessGroup(pr: RowInput): ReadinessGroup | null {
  const state = pr.state.toUpperCase();
  if (state === "MERGED" || state === "CLOSED") return null;
  if (pr.is_draft) return "draft";
  const reason = rowReason(pr);
  if (reason.tone === "danger" || reason.label === "Behind") return "needs_attention";
  const decision = (pr.review_decision ?? "").toUpperCase();
  const mss = (pr.merge_state_status ?? "").toUpperCase();
  if (decision === "APPROVED" || (!decision && (mss === "CLEAN" || mss === "HAS_HOOKS"))) return "approved";
  return "awaiting_review";
}

// ---- lists ----

export type PrFilter = "open" | "merged" | "closed" | "all";
export const PR_FILTERS: readonly { value: PrFilter; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "merged", label: "Merged" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
];

/** Title, head branch or number ("#12" or "12"). */
export function matchesPrQuery(pr: Pick<PullRequest, "title" | "head" | "number">, query: string): boolean {
  const q = query.trim().toLowerCase().replace(/^#/, "");
  return !q || pr.title.toLowerCase().includes(q) || pr.head.toLowerCase().includes(q) || String(pr.number).includes(q);
}

/** Newest activity first across projects. */
export function byUpdated<T extends { pr: Pick<PullRequest, "updated_at"> }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => b.pr.updated_at.localeCompare(a.pr.updated_at));
}

/** "No open pull requests", "No pull requests": the empty list's title for a filter. */
export function emptyPrTitle(filter: PrFilter): string {
  return filter === "all" ? "No pull requests" : `No ${filter} pull requests`;
}

// ---- checkout and repair conversations ----

type ThreadLike = Pick<Thread, "id" | "project_id" | "status" | "worktree" | "subagent" | "delegation">;

/** Conversations in this project with their own worktree: where a checkout or repair can run. */
export function repairChoices<T extends ThreadLike>(threads: readonly T[], projectId: string): T[] {
  return threads.filter(
    (t) => t.project_id === projectId && !!t.worktree && t.status !== "archived" && !t.subagent && !t.delegation,
  );
}

/**
 * The conversation a draft repairs in: the one it chose (`"new"` asks for a new one), else a
 * worktree conversation already on the pull request's head branch.
 */
export function linkedRepairThread<T extends ThreadLike>(
  threads: readonly T[],
  projectId: string,
  head: string | undefined,
  chosen: string | null,
): T | undefined {
  const choices = repairChoices(threads, projectId);
  if (chosen === "new") return undefined;
  if (chosen) return choices.find((t) => t.id === chosen);
  return head ? choices.find((t) => t.worktree?.branch === head) : undefined;
}

/** A conversation that is working (or waiting on you) can't take a checkout or repair yet. */
export function repairBlocked(thread: Pick<Thread, "status"> | undefined): boolean {
  return thread?.status === "running" || thread?.status === "awaiting-approval";
}
