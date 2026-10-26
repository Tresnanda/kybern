// The cards a Coordinator raises, as both clients show them: the brief proposal (editable
// text), the settings proposal (old → new rows the user can untick) and the git approvals
// (push, open a pull request, merge one). Reading each card's input, the words on it, and
// the one quiet line a settled card leaves in the transcript.
import {
  COORDINATOR_BRIEF_TOOL,
  COORDINATOR_NOTES_TOOL,
  COORDINATOR_SETTINGS_TOOL,
  LEAD_GIT_TOOL,
  type ApprovalDecision,
  type ApprovalRequest,
  type BriefProposalInput,
  type LeadGitCardInput,
  type NoteChange,
  type NoteChangesProposalInput,
  type PrChecksSummary,
  type SettingChange,
  type SettingsProposalInput,
} from "./types.ts";

/** Why the daemon closes a card nobody answered. */
const TURN_ENDED = "turn ended";
const TIMED_OUT = "timed out";

type Card = Pick<ApprovalRequest, "tool_name" | "input">;

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const text = (value: unknown) => (typeof value === "string" ? value : "");
const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0);

export const COORDINATOR_CARD_COPY = {
  briefTitle: "Save this as the project brief?",
  briefReplaceTitle: "Replace the project brief?",
  briefDetail: "From your setup answers. Edit anything before saving; only you can change the brief.",
  briefFootnote: "You can change it later in the Project tab.",
  briefSave: "Save brief",
  briefEmpty: "Write the brief before saving it, or decline.",
  settingsTitle: "Apply these Coordinator settings?",
  settingsDetail: "For this project. Untick anything you want to keep.",
  notesDetail: "Each change adds a dated claim. A replaced line is struck through. Untick anything you want to keep.",
  notesSupersedes: "Replaces",
  tidyMeta: "Files they cite changed after they were written.",
  tidyHint: "An agent checks them. You approve each change.",
  tidyNotNow: "Not now",
  tidyAction: "Tidy notes",
  decline: "Decline",
  saving: "Saving…",
  mergeWarning: "This can't be undone from Kybern.",
  answerFailed: "Unable to send your answer. Check the connection and try again.",
} as const;

export function briefProposalInput(approval: Card): BriefProposalInput | null {
  if (approval.tool_name !== COORDINATOR_BRIEF_TOOL) return null;
  const input = record(approval.input);
  if (!input) return null;
  return { text: text(input.text), replaces: input.replaces === true };
}

export function settingsProposalInput(approval: Card): SettingsProposalInput | null {
  if (approval.tool_name !== COORDINATOR_SETTINGS_TOOL) return null;
  const input = record(approval.input);
  if (!input) return null;
  const changes: SettingChange[] = [];
  for (const item of Array.isArray(input.changes) ? input.changes : []) {
    const change = record(item);
    const path = text(change?.path);
    if (!change || !path) continue;
    changes.push({ path, label: text(change.label) || path, old: change.old ?? null, new: change.new ?? null });
  }
  return { reason: text(input.reason), changes };
}

/** The note-changes card: each row appends a claim, optionally retiring a line. */
export function noteChangesProposalInput(approval: Card): NoteChangesProposalInput | null {
  if (approval.tool_name !== COORDINATOR_NOTES_TOOL) return null;
  const input = record(approval.input);
  if (!input) return null;
  const changes: NoteChange[] = [];
  for (const item of Array.isArray(input.changes) ? input.changes : []) {
    const change = record(item);
    const path = text(change?.path);
    if (!change || !path) continue;
    const supersedes = text(change.supersedes);
    changes.push({
      path,
      note_id: text(change.note_id),
      note_title: text(change.note_title),
      op: change.op === "supersede" ? "supersede" : "append",
      text: text(change.text),
      supersedes: supersedes || null,
      category: ["preference", "decision", "convention", "gotcha"].includes(text(change.category)) ? (text(change.category) as NoteChange["category"]) : null,
    });
  }
  return { reason: text(input.reason), changes };
}

/** The card's title: "Apply 3 note changes?". */
export function noteChangesTitle(count: number): string {
  return `Apply ${count} note ${count === 1 ? "change" : "changes"}?`;
}

/** The "Tidy notes" offer's title: "5 notes may be outdated". */
export function tidyOfferTitle(count: number): string {
  return `${count} ${count === 1 ? "note" : "notes"} may be outdated`;
}

export function leadGitCardInput(approval: Card): LeadGitCardInput | null {
  if (approval.tool_name !== LEAD_GIT_TOOL) return null;
  const input = record(approval.input);
  if (!input) return null;
  switch (input.op) {
    case "push":
      return { op: "push", remote: text(input.remote) || "origin", branch: text(input.branch), ahead: count(input.ahead) };
    case "open_pr":
      return {
        op: "open_pr",
        remote: text(input.remote) || "origin",
        branch: text(input.branch),
        ahead: count(input.ahead),
        title: text(input.title),
        body: text(input.body),
        base: text(input.base),
      };
    case "merge_pr": {
      const checks = record(input.checks);
      return {
        op: "merge_pr",
        number: count(input.number),
        title: text(input.title),
        checks: { total: count(checks?.total), passed: count(checks?.passed), failed: count(checks?.failed), pending: count(checks?.pending), skipped: count(checks?.skipped) },
        method: input.method === "merge" ? "merge" : "squash",
      };
    }
    default:
      return null;
  }
}

export type CoordinatorCardKind = "brief" | "settings" | "notes" | "push" | "open_pr" | "merge_pr";

/** Which Coordinator card an approval is, for its icon; null for any other approval. */
export function coordinatorCardKind(approval: Card): CoordinatorCardKind | null {
  if (approval.tool_name === COORDINATOR_BRIEF_TOOL) return "brief";
  if (approval.tool_name === COORDINATOR_SETTINGS_TOOL) return "settings";
  if (approval.tool_name === COORDINATOR_NOTES_TOOL) return "notes";
  return leadGitCardInput(approval)?.op ?? null;
}

/** Any of the Coordinator's own cards. */
export function isCoordinatorCard(approval: Card): boolean {
  return (
    approval.tool_name === COORDINATOR_BRIEF_TOOL ||
    approval.tool_name === COORDINATOR_SETTINGS_TOOL ||
    approval.tool_name === COORDINATOR_NOTES_TOOL ||
    approval.tool_name === LEAD_GIT_TOOL
  );
}

const commits = (n: number) => `${n} ${n === 1 ? "commit" : "commits"}`;

/** A text run with code spans marked, so each client can set branch names as code. */
export type CardTextPart = { text: string; code?: boolean };

/** The card's title and the line under it. */
export function gitCardCopy(input: LeadGitCardInput): { title: CardTextPart[]; detail: CardTextPart[]; action: string } {
  switch (input.op) {
    case "push":
      return {
        title: [{ text: "Push " }, { text: input.branch, code: true }, { text: "?" }],
        detail: [{ text: `${commits(input.ahead)} to send to ${input.remote}.` }],
        action: "Push",
      };
    case "open_pr":
      return {
        title: [{ text: "Push " }, { text: input.branch, code: true }, { text: " and open a pull request?" }],
        detail: input.base
          ? [{ text: `${commits(input.ahead)} ahead of ` }, { text: input.base, code: true }, { text: ` on ${input.remote}.` }]
          : [{ text: `${commits(input.ahead)} to send to ${input.remote}.` }],
        action: "Push and open PR",
      };
    case "merge_pr":
      return {
        title: [{ text: `${input.method === "squash" ? "Squash-merge" : "Merge"} PR #${input.number}?` }],
        detail: input.title ? [{ text: input.title }] : [],
        action: "Merge PR",
      };
  }
}

/** "6 checks passed", "1 check failing", "2 checks running", or null without checks. */
export function checksLabel(checks: PrChecksSummary): { text: string; tone: "ok" | "bad" | "pending" } | null {
  const plural = (n: number, word: string) => `${n} ${n === 1 ? "check" : "checks"} ${word}`;
  if (checks.total === 0) return null;
  if (checks.failed > 0) return { text: plural(checks.failed, "failing"), tone: "bad" };
  if (checks.pending > 0) return { text: plural(checks.pending, "running"), tone: "pending" };
  return { text: plural(checks.passed, "passed"), tone: "ok" };
}

export function mergeMethodLabel(method: "squash" | "merge"): string {
  return method === "squash" ? "Squash" : "Merge commit";
}

export type CoordinatorCardOutcome = "pending" | "done" | "declined" | "ended";

export function coordinatorCardOutcome(decision: ApprovalDecision | null): CoordinatorCardOutcome {
  if (!decision) return "pending";
  if (decision.decision === "deny") return decision.reason === TURN_ENDED || decision.reason === TIMED_OUT ? "ended" : "declined";
  return "done";
}

function acceptedCount(decision: ApprovalDecision | null, fallback: number): number {
  if (decision?.decision !== "submit") return fallback;
  const accepted = record(decision.response)?.accepted;
  return Array.isArray(accepted) ? accepted.length : fallback;
}

/**
 * The one line a Coordinator card leaves in the transcript, or null for any other
 * approval. `live` is false once the turn is over: a card still unanswered then reads as ended.
 */
export function coordinatorCardLine(approval: Card, decision: ApprovalDecision | null, live = true): CardTextPart[] | null {
  const raw = coordinatorCardOutcome(decision);
  const outcome = raw === "pending" && !live ? "ended" : raw;
  const ended = (): CardTextPart[] => [{ text: decision?.decision === "deny" && decision.reason === TIMED_OUT ? "Request ended: no answer in time" : "Request ended: the Coordinator stopped before you answered" }];
  const brief = briefProposalInput(approval);
  if (brief) {
    if (outcome === "pending") return [{ text: "Waiting for you to review the project brief" }];
    if (outcome === "done") return [{ text: "Saved the project brief" }];
    return outcome === "declined" ? [{ text: "Declined the project brief" }] : ended();
  }
  const settings = settingsProposalInput(approval);
  if (settings) {
    if (outcome === "pending") return [{ text: "Waiting for you to review Coordinator settings" }];
    if (outcome === "done") {
      const n = acceptedCount(decision, settings.changes.length);
      return [{ text: `Applied ${n} Coordinator ${n === 1 ? "setting" : "settings"}` }];
    }
    return outcome === "declined" ? [{ text: "Declined Coordinator settings" }] : ended();
  }
  const notes = noteChangesProposalInput(approval);
  if (notes) {
    if (outcome === "pending") return [{ text: "Waiting for you to review note changes" }];
    if (outcome === "done") {
      const n = acceptedCount(decision, notes.changes.length);
      return [{ text: `Applied ${n} note ${n === 1 ? "change" : "changes"}` }];
    }
    return outcome === "declined" ? [{ text: "Declined note changes" }] : ended();
  }
  const git = leadGitCardInput(approval);
  if (git) {
    if (outcome === "ended") return ended();
    switch (git.op) {
      case "push":
        return outcome === "done" ? [{ text: "Pushed " }, { text: git.branch, code: true }]
          : outcome === "declined" ? [{ text: "Declined pushing " }, { text: git.branch, code: true }]
            : [{ text: "Waiting for you to allow pushing " }, { text: git.branch, code: true }];
      case "open_pr":
        return outcome === "done" ? [{ text: "Opened a pull request for " }, { text: git.branch, code: true }]
          : outcome === "declined" ? [{ text: "Declined opening a pull request for " }, { text: git.branch, code: true }]
            : [{ text: "Waiting for you to allow a pull request for " }, { text: git.branch, code: true }];
      case "merge_pr":
        return [{ text: outcome === "done" ? `Merged PR #${git.number}` : outcome === "declined" ? `Declined merging PR #${git.number}` : `Waiting for you to allow merging PR #${git.number}` }];
    }
  }
  return null;
}

export function cardPartsText(parts: readonly CardTextPart[]): string {
  return parts.map((part) => part.text).join("");
}
