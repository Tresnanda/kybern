// Coordinator context refresh (rotation) as clients show it: the row's label, the handoff card's meta line and
// sections, and the budget choices. Pure, so GPUIX and the other clients say the same words. The reducer's
// `rotation` block (`transcript.ts`) is the data; the spec is `docs/design/coordinator-context.md` §2 and §10.1.
import { PROVIDER_DISPLAY_NAME, type HandoffStatus, type HarnessRef, type RotationCarried, type RotationReason } from "./types.ts";

export const ROTATION_COPY = {
  pending: "Refreshing context…",
  handoff: "Handoff",
  noHandoff: "No handoff",
  edit: "Edit handoff",
  cancel: "Cancel",
  save: "Save handoff",
  editHint: "The Coordinator gets your correction with your next message.",
  edited: "Edited by you",
  refreshNow: "Refresh now",
  refreshMenu: "Refresh context",
  refreshAt: "Refreshes at",
  refreshOff: "Automatic refresh is off",
  refreshMeta: "Starts a fresh session with a handoff",
  settingTitle: "Refresh Coordinator context at",
  settingDetail: "Starts a fresh session with a handoff when the Coordinator's context passes this size.",
  useDefault: "Use default",
  refreshFailed: "Unable to refresh the context",
  editFailed: "Unable to save the handoff",
} as const;

/** The pick list for `rotation_budget_tokens`: 100k, 200k, 400k, Off. The daemon accepts 0 or at least 50 000. */
export const ROTATION_BUDGET_OPTIONS: readonly { value: number; label: string }[] = [
  { value: 100_000, label: "100k" },
  { value: 200_000, label: "200k" },
  { value: 400_000, label: "400k" },
  { value: 0, label: "Off" },
];

/** The pick list as select options (string values), with a value set elsewhere (the CLI) kept so the control never reads blank. */
export function rotationBudgetChoices(current?: number | null): { value: string; label: string }[] {
  const options = ROTATION_BUDGET_OPTIONS.map((option) => ({ value: String(option.value), label: option.label }));
  if (typeof current === "number" && !ROTATION_BUDGET_OPTIONS.some((option) => option.value === current)) options.splice(options.length - 1, 0, { value: String(current), label: formatTokens(current) });
  return options;
}

/** What the daemon uses when neither a project nor Settings sets a budget. */
export const DEFAULT_ROTATION_BUDGET = 200_000;

/** "200k", "1.5M", "950": a token count as the popover and the row say it. */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0";
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(Math.round(tokens));
}

/** The label of a budget value in the pick list ("Off" for 0), or the count itself for a value the list lacks. */
export function rotationBudgetLabel(value: number): string {
  return ROTATION_BUDGET_OPTIONS.find((option) => option.value === value)?.label ?? formatTokens(value);
}

/**
 * The size at which the daemon refreshes: the budget, but never past half the model's window. `0` is off (automatic
 * refresh never runs); an unknown window leaves the budget as set.
 */
export function effectiveRotationBudget(budget: number | null | undefined, windowTokens: number | null | undefined): number {
  const set = budget ?? DEFAULT_ROTATION_BUDGET;
  if (set <= 0) return 0;
  return windowTokens && windowTokens > 0 ? Math.min(set, Math.floor(windowTokens / 2)) : set;
}

/** The state of the pieces of a rotation block the copy needs. */
export interface RotationView {
  reason: RotationReason;
  pending: boolean;
  usedTokens: number;
  handoffStatus: HandoffStatus | null;
  carried: RotationCarried | null;
  to: HarnessRef | null;
}

/** "Claude Code", "Codex": the harness a switch landed on. */
export function harnessName(ref: HarnessRef | null | undefined): string {
  if (!ref) return "the new harness";
  return PROVIDER_DISPLAY_NAME[ref.kind] ?? ref.kind;
}

/** A handoff that never came: the old session timed out, failed validation twice or was gone. */
export const handoffMissing = (view: Pick<RotationView, "handoffStatus">) => view.handoffStatus?.status === "missing";

/** The row's text: "Refreshing context…" while pending, else by reason and handoff. `time` is the local "14:02". */
export function rotationLabel(view: RotationView, time: string): string {
  if (view.pending) return ROTATION_COPY.pending;
  if (view.reason === "harness_switch") return `Switched to ${harnessName(view.to)} · context carried`;
  if (handoffMissing(view)) return `Context refreshed without a handoff · ${time}`;
  if (view.reason === "manual") return `Context refreshed by you · ${time}`;
  return `Context refreshed · ${time}`;
}

/** The size a "Passed …" phrase names: the used count floored to a round figure (203 412 → "200k", 71 000 → "70k"). */
function passedTokens(used: number): string {
  const step = used >= 100_000 ? 50_000 : 10_000;
  return formatTokens(Math.max(step, Math.floor(used / step) * step));
}

/** Why the session was refreshed, in the words the card's meta line starts with. */
export function rotationReasonPhrase(view: Pick<RotationView, "reason" | "usedTokens" | "to">): string {
  switch (view.reason) {
    case "budget": return `Passed ${passedTokens(view.usedTokens)} tokens`;
    case "idle": return "Refreshed after sitting idle";
    case "manual": return "Refreshed by you";
    case "harness_switch": return `Switched to ${harnessName(view.to)}`;
  }
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "3 agents, 1 pull request, 5 commits": what Kybern carried over, leaving out what is zero; null when nothing was. */
export function carriedPhrase(carried: RotationCarried | null | undefined): string | null {
  if (!carried) return null;
  const parts = [
    carried.children > 0 ? count(carried.children, "agent") : null,
    carried.pull_requests > 0 ? count(carried.pull_requests, "pull request") : null,
    carried.tasks > 0 ? count(carried.tasks, "task") : null,
    carried.commits > 0 ? count(carried.commits, "commit") : null,
  ].filter((part): part is string => !!part);
  return parts.length ? parts.join(", ") : null;
}

/** The handoff card's meta line: "Passed 200k tokens · carried 3 agents, 1 pull request, 5 commits". */
export function rotationMeta(view: RotationView): string {
  const carried = carriedPhrase(view.carried);
  const base = rotationReasonPhrase(view);
  if (handoffMissing(view)) return `${base} · carried ${carried ? `${carried} and the recent messages` : "the recent messages"}`;
  return carried ? `${base} · carried ${carried}` : base;
}

/** The missing-handoff card's explanation. `why` is the daemon's own sentence ("Kybern restarted before the handoff was written."). */
export function missingHandoffText(status: HandoffStatus | null): string {
  const why = status?.status === "missing" ? status.why.trim().replace(/[.\s]+$/, "") : "";
  const lead = why ? `${why}.` : "The previous session did not leave a handoff.";
  return `${lead} The new session started from Kybern's facts and the recent messages, and can read older history in this thread.`;
}

/** One section of a handoff: its heading as written and the label shown for it. */
export interface HandoffSection {
  /** The heading text without `##`, as written ("Decisions (date, what, why, commit if any)"). */
  heading: string;
  /** The heading with the prompt's parenthetical hint dropped ("Decisions"). */
  label: string;
  body: string;
  /** The section says "None" (shown tertiary). */
  none: boolean;
}

/** Split handoff markdown at its `## ` headings. Text before the first heading is kept as an unlabelled section. */
export function parseHandoff(markdown: string | null | undefined): HandoffSection[] {
  if (!markdown?.trim()) return [];
  const sections: HandoffSection[] = [];
  let heading: string | null = null;
  let lines: string[] = [];
  const flush = () => {
    const body = lines.join("\n").trim();
    if (heading === null && !body) return;
    const title = heading ?? "";
    sections.push({ heading: title, label: title.replace(/\s*\(.*\)\s*$/, "").trim(), body, none: !body || /^none\.?$/i.test(body) });
  };
  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const match = /^##\s+(.*)$/.exec(line);
    if (match) {
      flush();
      heading = match[1]!.trim();
      lines = [];
    } else lines.push(line);
  }
  flush();
  return sections;
}

/** True when `edited` text is worth sending: not blank, and not what is already there. */
export function handoffEditable(next: string, current: string | null | undefined): boolean {
  return next.trim().length > 0 && next.trim() !== (current ?? "").trim();
}
