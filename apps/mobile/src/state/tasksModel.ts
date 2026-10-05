// Pure task logic: statuses, runs, change folding, grouping, the body's
// acceptance criteria, the Send prompt and its defaults. Keep this file free of
// React and native imports so it stays unit-testable. It mirrors the desktop's
// tasksModel so both clients read a task the same way.
import type {
  PermissionMode,
  ProviderKind,
  ProviderStatus,
  TaskItem,
  TaskItemsChangedNotification,
  TaskPriority,
  TaskRun,
  TaskStatus,
  Thread,
} from "./protocol";
import { cachedProjectHue } from "../../../../packages/kybern-client/src/projectColors";

export const METHOD_NOT_FOUND = -32601;
/** Matches RpcError CONFLICT from the daemon. */
export const TASKS_CONFLICT = -32004;
export const UNDO_MS = 6000;
export const TOAST_MS = 5000;

// ---- statuses and priorities ----

export const STATUS_LABEL: Record<TaskStatus, string> = {
  inbox: "Inbox",
  todo: "To do",
  running: "Running",
  needs_review: "Needs review",
  done: "Done",
  canceled: "Canceled",
};
/** List groups, the work that needs attention first. */
export const LIST_STATUS_ORDER: TaskStatus[] = [
  "running",
  "needs_review",
  "todo",
  "inbox",
  "done",
  "canceled",
];
/** Statuses a person sets. Running and Needs review belong to the latest run. */
export const USER_STATUSES: TaskStatus[] = ["inbox", "todo", "done", "canceled"];
export const isUserStatus = (status: TaskStatus) =>
  USER_STATUSES.includes(status);
export const isOpenStatus = (status: TaskStatus) =>
  status !== "done" && status !== "canceled";

export const PRIORITY_LABEL: Record<TaskPriority, string> = {
  0: "No priority",
  1: "Urgent",
  2: "High",
  3: "Medium",
  4: "Low",
};
/** Menu order, like Linear: none first, then most to least urgent. */
export const PRIORITY_MENU_ORDER: TaskPriority[] = [0, 1, 2, 3, 4];
/** Sort weight: urgent first, no priority last. */
export const priorityWeight = (priority: TaskPriority) =>
  priority === 0 ? 5 : priority;

export const taskTitle = (task: Pick<TaskItem, "title">) =>
  task.title.trim() || "Untitled task";

// ---- runs ----

export function latestRun(task: Pick<TaskItem, "runs">): TaskRun | null {
  let best: TaskRun | null = null;
  for (const run of task.runs ?? [])
    if (!best || run.number > best.number) best = run;
  return best;
}
export const isLiveRun = (run: TaskRun | null | undefined) =>
  run?.state === "running" || run?.state === "waiting";

/** Minutes and hours, compact: "<1m", "12m", "1h 4m". */
export function shortDuration(ms: number) {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}
export function runDuration(run: TaskRun, now: number) {
  const start = Date.parse(run.started_at);
  const end = run.ended_at ? Date.parse(run.ended_at) : now;
  return Number.isNaN(start) || Number.isNaN(end) ? 0 : Math.max(0, end - start);
}
/** "Running for 12m", "Finished in 8m", "Canceled after 2m". */
export function runOutcome(run: TaskRun, now: number) {
  const time = shortDuration(runDuration(run, now));
  switch (run.state) {
    case "running":
      return `Running for ${time}`;
    case "waiting":
      return "Waiting for you";
    case "completed":
      return `Finished in ${time}`;
    case "failed":
      return `Failed after ${time}`;
    case "interrupted":
      return `Canceled after ${time}`;
  }
}
/** "Editing crates/x/cursor.rs" → "Editing cursor.rs": phones have room for the file name only. */
export const shortActivity = (activity: string) =>
  activity.replace(/(\S*\/)+(\S+)/g, "$2");

/** "+48 −12 in 3 files". */
export function diffLabel(diff: TaskRun["diff"]) {
  if (!diff) return "";
  const files = diff.files === 1 ? "1 file" : `${diff.files} files`;
  return `+${diff.added} −${diff.removed} in ${files}`;
}

/** Compact age: "now", "12m", "3h", "2d", "5w". */
export function ageLabel(at: string, now: number) {
  const minutes = Math.max(0, (now - Date.parse(at)) / 60_000);
  if (Number.isNaN(minutes)) return "";
  if (minutes < 1) return "now";
  if (minutes < 60) return `${Math.floor(minutes)}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  if (minutes < 1440 * 14) return `${Math.floor(minutes / 1440)}d`;
  return `${Math.floor(minutes / 10080)}w`;
}

// ---- the list ----

const time = (at: string) => {
  const value = Date.parse(at);
  return Number.isNaN(value) ? 0 : value;
};

/** Fold one `tasks.items.changed` notification into the list. */
export function applyTaskChange(
  tasks: TaskItem[],
  change: TaskItemsChangedNotification,
) {
  if (change.deleted_id)
    return tasks.filter((task) => task.id !== change.deleted_id);
  const next = change.task;
  if (!next) return tasks;
  const index = tasks.findIndex((task) => task.id === next.id);
  if (index < 0) return [...tasks, next];
  // Never replace a newer row with an older notification that arrived late.
  const current = tasks[index]!;
  if (
    current.revision > next.revision ||
    time(current.updated_at) > time(next.updated_at)
  )
    return tasks;
  const copy = tasks.slice();
  copy[index] = next;
  return copy;
}

/** Changes made on this phone that the computer has not confirmed yet. */
export type TaskOverride = Partial<Pick<TaskItem, "status" | "priority" | "body">>;

export function withOverrides(
  tasks: TaskItem[],
  overrides: Record<string, TaskOverride>,
) {
  if (!Object.keys(overrides).length) return tasks;
  return tasks.map((task) =>
    overrides[task.id] ? { ...task, ...overrides[task.id] } : task,
  );
}

export function sortTasks(tasks: TaskItem[]) {
  return [...tasks].sort((a, b) => {
    // Finished work reads newest first; its rank no longer means anything.
    if (!isOpenStatus(a.status) && !isOpenStatus(b.status))
      return b.status_changed_at.localeCompare(a.status_changed_at);
    return a.rank - b.rank || compareTaskKeys(a.key, b.key);
  });
}

export interface TaskGroup {
  status: TaskStatus;
  tasks: TaskItem[];
}

/** Status groups in list order, empty groups left out. */
export function groupTasks(tasks: TaskItem[]): TaskGroup[] {
  return LIST_STATUS_ORDER.map((status) => ({
    status,
    tasks: sortTasks(tasks.filter((task) => task.status === status)),
  })).filter((group) => group.tasks.length > 0);
}

/** Done and Canceled start closed; everything else starts open. */
export const startsCollapsed = (status: TaskStatus) =>
  status === "done" || status === "canceled";

export function scopeTasks(tasks: TaskItem[], projectId?: string | null) {
  if (projectId === undefined) return tasks;
  if (projectId === null || projectId === "global")
    return tasks.filter((task) => task.scope === "global" || !task.project_id);
  return tasks.filter(
    (task) => task.scope === "project" && task.project_id === projectId,
  );
}

/** "2 running · 1 to review" for the navigation rows; empty when nothing is active. */
export function activitySummary(tasks: TaskItem[]) {
  let running = 0;
  let review = 0;
  for (const task of tasks) {
    if (task.status === "running") running++;
    else if (task.status === "needs_review") review++;
  }
  return [
    running ? `${running} running` : "",
    review ? `${review} to review` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

// ---- keys and links ----

const KEY_PATTERN = /^([A-Z][A-Z0-9]{1,4})-(\d+)$/;
export function splitTaskKey(key: string) {
  const match = KEY_PATTERN.exec(key.trim().toUpperCase());
  return match ? { prefix: match[1]!, number: Number(match[2]) } : null;
}
/** Sort keys by prefix, then number (ADE-9 before ADE-10). */
export function compareTaskKeys(a: string, b: string) {
  const x = splitTaskKey(a);
  const y = splitTaskKey(b);
  if (!x || !y) return a.localeCompare(b);
  return x.prefix === y.prefix
    ? x.number - y.number
    : x.prefix.localeCompare(y.prefix);
}

/** The task id in a `kybern://task/<id>` link, or null for any other link. */
export function taskLinkId(href: string) {
  const match = /^<?kybern:\/\/task\/([^\s/?#>]+)>?$/i.exec(href.trim());
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
}

// ---- body: description and acceptance criteria ----

export interface Criterion {
  checked: boolean;
  text: string;
}

const CRITERION_LINE = /^([-*+] \[)([ xX])(\] ?)(.*)$/;
const CRITERIA_HEADING =
  /^(?:#{1,6}\s+)?(?:\*\*)?(?:acceptance criteria|done when)(?:\*\*)?\s*:?\s*(?:\*\*)?$/i;

/**
 * A task's body is Markdown: a description, then optionally a checklist. The
 * checklist items are its acceptance criteria; everything else is the description.
 */
export function splitTaskBody(body: string) {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const kept: string[] = [];
  const criteria: Criterion[] = [];
  let inFence = false;
  let inItem = false;
  for (const line of lines) {
    if (/^(```|~~~)/.test(line)) inFence = !inFence;
    const match = inFence ? null : CRITERION_LINE.exec(line);
    if (match) {
      // A heading that only introduced the checklist goes with it.
      if (!inItem) {
        let last = kept.length - 1;
        while (last >= 0 && !kept[last]!.trim()) last--;
        if (last >= 0 && CRITERIA_HEADING.test(kept[last]!.trim()))
          kept.splice(last);
      }
      criteria.push({ checked: match[2] !== " ", text: match[4]!.trim() });
      inItem = true;
      continue;
    }
    // Indented lines under an item belong to it.
    if (inItem && /^\s{2,}\S/.test(line)) continue;
    inItem = false;
    kept.push(line);
  }
  const description = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { description, criteria };
}

/** Tick or untick the nth criterion in place, leaving every other byte as written. */
export function toggleCriterion(body: string, index: number) {
  const lines = body.split("\n");
  let inFence = false;
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r$/, "");
    if (/^(```|~~~)/.test(line)) inFence = !inFence;
    const match = inFence ? null : CRITERION_LINE.exec(line);
    if (!match) continue;
    if (seen++ !== index) continue;
    const mark = match[2] === " " ? "x" : " ";
    lines[i] = lines[i]!.replace(CRITERION_LINE, `$1${mark}$3$4`);
    return lines.join("\n");
  }
  return body;
}

/** `[ADE-14](kybern://task/…)` reads as "ADE-14"; other Markdown links read as their label. */
export const plainInline = (text: string) =>
  text
    .replace(/\[([^\]]+)\]\((?:[^)\s]+)\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/`([^`]+)`/g, "$1");

/** "<title>.\n\n<description>\n\nDone when:\n– criterion" plus any saved follow-up. */
export function buildTaskPrompt(task: Pick<TaskItem, "title" | "body" | "pending_followup">) {
  const { description, criteria } = splitTaskBody(task.body ?? "");
  const title = task.title.trim();
  const parts = [title && !/[.!?:…]$/.test(title) ? `${title}.` : title];
  if (description) parts.push(description);
  const items = criteria.map((c) => plainInline(c.text).trim()).filter(Boolean);
  if (items.length)
    parts.push(["Done when:", ...items.map((text) => `– ${text}`)].join("\n"));
  const followup = task.pending_followup?.trim();
  if (followup) parts.push(followup);
  return parts.filter(Boolean).join("\n\n");
}

/** About four characters a token: enough to say whether context is small or large. */
export const approxTokens = (chars: number) =>
  Math.ceil(Math.max(0, chars) / 4);
/** "0.7k", "1.8k", "24k". */
export function formatTokens(tokens: number) {
  if (tokens <= 0) return "0k";
  if (tokens < 100) return "0.1k";
  if (tokens < 10_000) return `${(Math.round(tokens / 100) / 10).toFixed(1)}k`;
  return `${Math.round(tokens / 1000)}k`;
}

// ---- Send to agent defaults ----

export interface SendDefaults {
  provider: ProviderKind;
  instance: string;
  model: string;
  effort: string;
  permission: PermissionMode;
  worktree: boolean;
}

/**
 * The agent last used in this project (its newest top-level thread), else the
 * computer's defaults. Git projects run in a new worktree unless that project's
 * last thread ran in place.
 */
export function sendDefaults(input: {
  projectId: string | null;
  isGit: boolean;
  threads: Pick<
    Thread,
    | "project_id"
    | "parent_thread_id"
    | "provider"
    | "model"
    | "effort"
    | "permission_mode"
    | "worktree"
    | "created_at"
  >[];
  providers: Pick<ProviderStatus, "kind" | "available" | "instances" | "supported_permission_modes">[];
  fallback: SendDefaults;
}): SendDefaults {
  const usable = (kind: ProviderKind) =>
    input.providers.some((p) => p.kind === kind && p.available);
  const last = input.projectId
    ? input.threads
        .filter(
          (t) =>
            t.project_id === input.projectId &&
            !t.parent_thread_id &&
            usable(t.provider.kind),
        )
        .sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
    : undefined;
  let result: SendDefaults = last
    ? {
        provider: last.provider.kind,
        instance: last.provider.instance || "default",
        model: last.model ?? "",
        effort: last.effort ?? "",
        permission: last.permission_mode,
        worktree: !!last.worktree,
      }
    : { ...input.fallback, worktree: true };
  if (!usable(result.provider)) {
    const first = input.providers.find((p) => p.available);
    if (first && first.kind !== result.provider)
      result = {
        ...result,
        provider: first.kind,
        instance: first.instances[0] ?? "default",
        model: "",
        effort: "",
      };
  }
  const status = input.providers.find((p) => p.kind === result.provider);
  const modes = status?.supported_permission_modes ?? [];
  if (modes.length && !modes.includes(result.permission))
    result = { ...result, permission: modes[0]! };
  return { ...result, worktree: input.isGit ? result.worktree : false };
}

/** The model's name without the agent's brand: "Claude Opus 5.5" beside Claude Code reads "Opus 5.5". */
export function modelLabel(provider: ProviderKind, name: string) {
  return provider === "claude-code" ? name.replace(/^Claude\s+/i, "") : name;
}

// ---- project color ----

/**
 * One soft hue per project, the same as the desktop's: projects take hues in the
 * order they were added (packages/kybern-client/src/projectColors.ts).
 */
export { projectHue } from "../../../../packages/kybern-client/src/projectColors";

/** OKLCH to an sRGB hex string, clamped to the gamut. */
export function oklchHex(l: number, c: number, h: number) {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const channel = (x: number) => {
    const v = Math.max(0, Math.min(1, x));
    const g = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
    return Math.round(g * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_)}${channel(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_)}${channel(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_)}`;
}

/** The project's dot color for the current theme, among the environment's projects. */
export function projectColor(
  id: string,
  dark: boolean,
  projects: readonly { id: string; created_at: string }[] = [],
) {
  const hue = cachedProjectHue(id, projects);
  return dark ? oklchHex(0.74, 0.1, hue) : oklchHex(0.62, 0.13, hue);
}
