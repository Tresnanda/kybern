// The Agents sheet's model: one list of everything a thread started. "Agents" merges
// delegated child threads, provider subagent threads and agent runtime tasks that have
// no thread of their own; "Processes" holds shell commands and monitors. Running rows
// come first (oldest first, so they don't jump), then finished ones (newest first).
// Pure, so the rules are testable and the thread footer, the sheet and the transcript's
// "3 processes running" row agree on the counts.
import { childState, type ChildPhase } from "../../../../packages/kybern-client/src/delegations.ts";
import { displayCommand } from "../../../../packages/kybern-client/src/displayCommand.ts";
import { runtimeTaskState } from "../../../../packages/kybern-client/src/statusWords.ts";
import { formatElapsed, subagentDetail } from "../../../../packages/kybern-client/src/subagents.ts";
import type { ProviderKind, RuntimeTask, Thread } from "./protocol";

export type AgentRow = {
  key: string;
  /** Opens a child thread, or a runtime task's activity. */
  target: { thread: string } | { task: string };
  title: string;
  /** Machine text (a command): draw it in mono. */
  mono: boolean;
  /** "Working · 4m 12s", "Completed · 12s · 2 min ago". */
  subtitle: string;
  phase: ChildPhase;
  active: boolean;
  provider?: ProviderKind;
};

export type AgentsModel = {
  agents: AgentRow[];
  processes: AgentRow[];
  runningAgents: number;
  runningProcesses: number;
};

const time = (value: string | null | undefined) => {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
};

/** "now", "2 min ago", "3 h ago", "Oct 21". */
export function ago(at: number, now: number) {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "Working · 1m 04s" while active, "Completed · 12s · 2 min ago" once settled. */
function line(word: string, active: boolean, started: number, ended: number, now: number, extra?: string) {
  const parts = [word];
  if (extra) parts.push(extra);
  if (started) {
    if (active) parts.push(formatElapsed(now - started));
    else {
      if (ended > started) parts.push(formatElapsed(ended - started));
      parts.push(ago(ended || started, now));
    }
  }
  return parts.join(" · ");
}

const isActive = (phase: ChildPhase) => phase === "working" || phase === "waiting";

function threadRow(child: Thread, now: number): AgentRow {
  const state = childState(child);
  const active = isActive(state.phase);
  const started = time(child.delegation?.started_at ?? child.subagent?.started_at ?? child.created_at);
  const ended = time(child.delegation?.completed_at ?? child.subagent?.completed_at ?? child.updated_at);
  const live = child.subagent && active ? subagentDetail(child)?.text : undefined;
  return {
    key: `thread:${child.id}`,
    target: { thread: child.id },
    title: child.title || "Agent",
    mono: false,
    subtitle: line(state.word, active, started, ended, now, live),
    phase: state.phase,
    active,
    provider: child.provider.kind,
  };
}

function taskRow(task: RuntimeTask, now: number): AgentRow {
  const state = runtimeTaskState(task.status, task.backgrounded);
  const active = isActive(state.phase);
  const agent = task.kind === "agent";
  return {
    key: `task:${task.id}`,
    target: { task: task.id },
    title: agent ? task.title || "Agent" : displayCommand(task.title).text || "Command",
    mono: !agent,
    subtitle: line(
      state.word,
      active,
      time(task.started_at),
      time(task.completed_at ?? task.updated_at),
      now,
      agent && active && task.last_tool_name ? `Using ${task.last_tool_name}` : undefined,
    ),
    phase: state.phase,
    active,
  };
}

function order(rows: AgentRow[], started: Map<string, number>) {
  const at = (row: AgentRow) => started.get(row.key) ?? 0;
  return [
    ...rows.filter((row) => row.active).sort((a, b) => at(a) - at(b)),
    ...rows.filter((row) => !row.active).sort((a, b) => at(b) - at(a)),
  ];
}

/**
 * Everything `children` (threads whose parent is this one) and `tasks` (this
 * thread's runtime tasks) describe. A subagent thread stands for its own agent
 * task, so that task is not listed twice.
 */
export function agentsModel(children: readonly Thread[], tasks: readonly RuntimeTask[], now = Date.now()): AgentsModel {
  const started = new Map<string, number>();
  const mirrored = new Set(children.map((child) => child.subagent?.task_id).filter(Boolean));
  const agents: AgentRow[] = [];
  const processes: AgentRow[] = [];
  for (const child of children) {
    if (child.status === "archived" && !child.delegation && !child.subagent) continue;
    const row = threadRow(child, now);
    started.set(row.key, time(child.delegation?.started_at ?? child.subagent?.started_at ?? child.created_at));
    agents.push(row);
  }
  const ids = new Set(tasks.map((task) => task.id));
  for (const task of tasks) {
    // Nested tool tasks belong to their parent agent's activity page.
    if (task.parent_id && ids.has(task.parent_id)) continue;
    if (task.kind === "agent" && mirrored.has(task.id)) continue;
    const row = taskRow(task, now);
    started.set(row.key, time(task.started_at));
    (task.kind === "agent" ? agents : processes).push(row);
  }
  const sortedAgents = order(agents, started);
  const sortedProcesses = order(processes, started);
  return {
    agents: sortedAgents,
    processes: sortedProcesses,
    runningAgents: sortedAgents.filter((row) => row.active).length,
    runningProcesses: sortedProcesses.filter((row) => row.active).length,
  };
}

/** The bottom-bar capsule: "15 agents · 2 running", "3 processes running". Null when nothing was started. */
export function agentsCapsuleLabel(model: Pick<AgentsModel, "agents" | "processes" | "runningAgents" | "runningProcesses">) {
  // Only live work earns a place above the composer; finished agents stay one
  // tap away in the thread menu (Thread ▸ Agents).
  const running = model.runningAgents + model.runningProcesses;
  if (!running) return null;
  const agents = model.agents.length;
  if (agents) {
    const noun = agents === 1 ? "1 agent" : `${agents} agents`;
    return `${noun} · ${running} running`;
  }
  return model.runningProcesses === 1 ? "1 process running" : `${model.runningProcesses} processes running`;
}
