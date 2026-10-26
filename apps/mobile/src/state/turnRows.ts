import {
  createTurnGrouper,
  type Block,
  type TurnGroup,
} from "../../../../packages/kybern-client/src/transcript.ts";
import { runSummary } from "../../../../packages/kybern-client/src/workRun.ts";
import { signInRows } from "../../../../packages/kybern-client/src/signIn.ts";
import { toolLine } from "../../../../packages/kybern-client/src/toolActivity.ts";
import { orchestrationTool } from "../../../../packages/kybern-client/src/orchestrationTools.ts";
import type { LoginRecipe } from "../../../../packages/kybern-client/src/loginRecipes.ts";
import { visualAnswerInput } from "../../../../packages/kybern-client/src/visualAnswer.ts";
import { plural } from "./format.ts";

type RuntimeTaskBlock = Extract<Block, { kind: "runtime_task" }>;

export type TurnRow =
  | {
      kind: "block";
      key: string;
      block: Block;
      /** Inside an open step group: drawn as a compact work row. */
      nested: boolean;
      thinking: boolean;
      /** The command's output says its CLI is signed out: the row offers to sign in. */
      signIn?: LoginRecipe;
      /** First row of a turn (the user's message, or whatever opens a paginated turn). */
      first?: boolean;
    }
  | {
      kind: "work";
      key: string;
      /** The key `expandedTurns` toggles. */
      turnId: string;
      /** "12 steps · 3m 43s" for a finished turn, the run's summary while it runs. */
      label: string;
      /** "1 failed", shown apart from the label. */
      failed: string | null;
      expanded: boolean;
    }
  | {
      /** A finished turn that changed files: "Edited 3 files" with Undo on the newest turn. */
      kind: "files";
      key: string;
      threadId: string;
      turnId: string;
    }
  | {
      /** Two or more agents launched in one turn (subagents, delegated agents), as one disclosure. */
      kind: "agents";
      key: string;
      /** The key `expandedTurns` toggles. */
      turnId: string;
      threadId: string;
      launches: Block[];
      expanded: boolean;
    }
  | {
      kind: "processes";
      key: string;
      threadId: string;
      /** Shell and monitor tasks still running; never agents (they keep their own rows). */
      tasks: RuntimeTaskBlock["task"][];
    };

export function workDuration(milliseconds: number) {
  const seconds = Math.max(1, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export const ACTIVE_TASK = ["pending", "running", "waiting", "stopping"];
const activeTask = (block: Block): block is RuntimeTaskBlock =>
  block.kind === "runtime_task" && ACTIVE_TASK.includes(block.task.status);

/** A process or monitor still running: it folds into the one "N processes running" row. */
export const runningProcess = (block: Block): block is RuntimeTaskBlock =>
  activeTask(block) && block.task.kind !== "agent";

function launchesAgent(block: Extract<Block, { kind: "tool" }>) {
  const leaf = block.call.name.split(/__|[/:.]/).at(-1)!.toLowerCase().replace(/[^a-z]/g, "");
  return ["task", "agent", "subagent", "delegate", "spawnagent"].includes(leaf);
}

/** Delegations and messages to other threads keep their own rows ("Delegated …", "Sent to …"). */
export const orchestrationRow = (block: Block) => {
  if (block.kind !== "tool") return false;
  const tool = orchestrationTool(block.call.name);
  return tool === "agent_delegate" || tool === "thread_send";
};

/** An agent started in this turn: a provider subagent task, or a delegated child. */
export const agentLaunch = (block: Block) =>
  (block.kind === "runtime_task" && block.task.kind === "agent") ||
  (block.kind === "tool" && orchestrationTool(block.call.name) === "agent_delegate");

/** Settled work that folds into the step group. Agents, unanswered requests, errors and live output stay in the transcript. */
function folds(block: Block) {
  switch (block.kind) {
    case "tool":
      return block.complete && !block.isError && !launchesAgent(block) && !orchestrationRow(block);
    case "runtime_task":
      return block.task.kind !== "agent" && !activeTask(block);
    case "assistant":
      return block.complete;
    case "approval":
      return !!block.decision;
    case "notice":
      return block.level !== "error";
    default:
      // The user's steered messages, images and visuals always stay in the transcript.
      return false;
  }
}

/** A finished call that wrote files: its turn gets the edited-files card. */
const edits = (block: Block) =>
  block.kind === "tool" && block.complete && !block.isError && ["edit", "write"].includes(toolLine(block.call).kind);

/** "12 steps · 3m 43s": tool calls and processes count as steps; reasoning alone reads "Worked for 12s". */
function settledLabel(work: readonly Block[], durationMs: number) {
  const steps = work.filter((block) => block.kind === "tool" || block.kind === "runtime_task").length;
  const duration = workDuration(durationMs);
  return steps ? `${plural(steps, { one: "1 step", other: `${steps} steps` })} · ${duration}` : `Worked for ${duration}`;
}

/** Flatten work into the existing virtual list, never a giant nested scroll view. */
export function createTurnRows(threadId: string) {
  const groupTurns = createTurnGrouper();
  let cache = new Map<
    string,
    { group: TurnGroup; expanded: ReadonlySet<string>; rows: TurnRow[] }
  >();
  // Expansion keys of one turn: its own id and its running groups' keys.
  const turnKeys = (turnId: string, all: ReadonlySet<string>) =>
    new Set([...all].filter((key) => key === turnId || key.startsWith(`${turnId}:`)));
  const sameKeys = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
    a.size === b.size && [...a].every((key) => b.has(key));
  return (blocks: Block[], expandedTurns: ReadonlySet<string>): TurnRow[] => {
    const next = new Map<
      string,
      { group: TurnGroup; expanded: ReadonlySet<string>; rows: TurnRow[] }
    >();
    const result: TurnRow[] = [];
    for (const grouped of groupTurns(blocks)) {
      const expanded = turnKeys(grouped.turnId, expandedTurns);
      const previous = cache.get(grouped.turnId);
      if (grouped.end && previous?.group === grouped && sameKeys(previous.expanded, expanded)) {
        next.set(grouped.turnId, previous);
        result.push(...previous.rows);
        continue;
      }
      // A context refresh follows its turn, so it closes the turn's rows instead of folding into its work.
      const rotations = grouped.work.filter((block) => block.kind === "rotation");
      const group = rotations.length ? { ...grouped, work: grouped.work.filter((block) => block.kind !== "rotation") } : grouped;
      const rows: TurnRow[] = [];
      const chips = signInRows(group.work);
      // A visual that asks is answered under the visual itself, not by a separate card.
      const underVisual = (block: Block) => {
        const asks = block.kind === "approval" && !block.decision ? visualAnswerInput(block.approval) : null;
        return !!asks && !!group.visuals?.some((visual) => visual.id === asks.visual_id);
      };
      // A segment with neither text nor reasoning draws nothing; it must not leave an empty row.
      const empty = (block: Block) => block.kind === "assistant" && !block.text.trim() && !block.thinking.trim();
      const add = (block: Block, nested = false) =>
        !underVisual(block) &&
        !empty(block) &&
        rows.push({
          kind: "block",
          key: `${group.turnId}:${block.kind}:${block.id}`,
          block,
          nested,
          thinking: block.id === group.liveThinkingId,
          ...(block.kind === "tool" && chips.has(block.call.id) ? { signIn: chips.get(block.call.id) } : {}),
          ...(rows.length === 0 ? { first: true } : {}),
        });
      const processes = group.work.filter(runningProcess);
      const addProcesses = () => {
        if (processes.length)
          rows.push({ kind: "processes", key: `${group.turnId}:processes`, threadId, tasks: processes.map((block) => block.task) });
      };
      // A launch tool whose agent task is in the turn: the task's row stands for it.
      const taskCalls = new Set(
        group.work.flatMap((block) =>
          block.kind === "runtime_task" && block.task.kind === "agent" && block.task.tool_call_id ? [block.task.tool_call_id] : [],
        ),
      );
      const shadowed = (block: Block) => block.kind === "tool" && taskCalls.has(block.call.id);
      const launches = group.work.filter(agentLaunch);
      let groupShown = false;
      /** The agents group goes where the first launch was; later launches join it. */
      const addLaunch = (block: Block) => {
        if (launches.length < 2) return add(block);
        if (groupShown) return;
        groupShown = true;
        const key = `${group.turnId}:agents`;
        const open = expandedTurns.has(key);
        rows.push({ kind: "agents", key, turnId: key, threadId, launches, expanded: open });
        if (open) launches.forEach((launch) => add(launch, true));
      };
      if (group.user) add(group.user);
      // A paginated running turn may not have its user message loaded yet.
      // Settled steps fold into groups in place; narration and unfinished work stay visible.
      if (!group.end) {
        let run: Block[] = [];
        const flush = () => {
          const steps = run.filter((block) => block.kind !== "assistant");
          if (steps.length < 2) run.forEach((block) => add(block));
          else {
            const key = `${group.turnId}:run:${run[0]!.id}`;
            const open = expandedTurns.has(key);
            const summary = runSummary(run);
            rows.push({ kind: "work", key, turnId: key, label: summary.label, failed: summary.failed, expanded: open });
            if (open) run.forEach((block) => add(block, true));
          }
          run = [];
        };
        const work = [...group.work, ...group.images, ...(group.visuals ?? [])].sort((a, b) => a.seq - b.seq);
        for (const block of work) {
          if (runningProcess(block) || shadowed(block)) continue;
          if (agentLaunch(block)) {
            flush();
            addLaunch(block);
            continue;
          }
          // Narration is a step boundary: it stays readable, so it is never folded. Settled reasoning
          // without text is part of the run (the summary says "Thought"); live reasoning stays visible.
          const reasoningOnly = block.kind === "assistant" && !block.text.trim() && block.id !== group.liveThinkingId;
          if ((folds(block) && block.kind !== "assistant") || reasoningOnly) run.push(block);
          else {
            flush();
            add(block);
          }
        }
        flush();
        addProcesses();
      } else {
        const work = group.work.filter((block) => folds(block) && !runningProcess(block));
        group.work
          .filter((block) => !folds(block) && !runningProcess(block) && !shadowed(block))
          .forEach((block) => (agentLaunch(block) ? addLaunch(block) : add(block)));
        if (work.length) {
          const summary = runSummary(work);
          rows.push({
            kind: "work",
            key: `${group.turnId}:work`,
            turnId: group.turnId,
            label: settledLabel(work, group.end.durationMs),
            failed: summary.failed,
            expanded: expandedTurns.has(group.turnId),
          });
          if (expandedTurns.has(group.turnId)) work.forEach((block) => add(block, true));
        }
        addProcesses();
        group.visuals?.forEach((block) => add(block));
        group.images.forEach((block) => add(block));
        if (group.answer) add(group.answer);
        if (group.work.some(edits))
          rows.push({ kind: "files", key: `${group.turnId}:files`, threadId, turnId: group.turnId });
        add(group.end);
      }
      if (group.reverted) add(group.reverted);
      // Group worktree threads: repositories changed outside the worktree, after the turn's answer.
      group.outside?.forEach((block) => add(block));
      rotations.forEach((block) => add(block));
      next.set(group.turnId, { group: grouped, expanded, rows });
      result.push(...rows);
    }
    cache = next;
    return result;
  };
}
