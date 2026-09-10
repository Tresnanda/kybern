import {
  createTurnGrouper,
  type Block,
  type TurnGroup,
} from "../../../../packages/kybern-client/src/transcript.ts";

export type TurnRow =
  | { kind: "block"; key: string; block: Block; nested: boolean }
  | {
      kind: "work";
      key: string;
      turnId: string;
      durationMs: number;
      label?: string;
      expanded: boolean;
    };

export function workDuration(milliseconds: number) {
  const seconds = Math.max(1, Math.round(milliseconds / 1000));
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function launchesAgent(block: Extract<Block, { kind: "tool" }>) {
  const leaf = block.call.name.split(/__|[/:.]/).at(-1)!.toLowerCase().replace(/[^a-z]/g, "");
  return ["task", "agent", "subagent", "delegate", "spawnagent"].includes(leaf);
}

function staysVisible(block: Block) {
  return (
    (block.kind === "runtime_task" &&
      (block.task.kind === "agent" ||
        ["pending", "running", "waiting", "stopping", "failed"].includes(
          block.task.status,
        ))) ||
    (block.kind === "approval" && !block.decision) ||
    (block.kind === "tool" && !block.complete) ||
    (block.kind === "assistant" && !block.complete) ||
    (block.kind === "notice" && block.level === "error")
  );
}

/** Flatten work into the existing virtual list, never a giant nested scroll view. */
export function createTurnRows() {
  const groupTurns = createTurnGrouper();
  let cache = new Map<
    string,
    { group: TurnGroup; expanded: boolean; rows: TurnRow[] }
  >();
  return (blocks: Block[], expandedTurns: ReadonlySet<string>): TurnRow[] => {
    const next = new Map<
      string,
      { group: TurnGroup; expanded: boolean; rows: TurnRow[] }
    >();
    const result: TurnRow[] = [];
    for (const group of groupTurns(blocks)) {
      const expanded = expandedTurns.has(group.turnId);
      const previous = cache.get(group.turnId);
      if (group.end && previous?.group === group && previous.expanded === expanded) {
        next.set(group.turnId, previous);
        result.push(...previous.rows);
        continue;
      }
      const rows: TurnRow[] = [];
      const add = (block: Block, nested = false) =>
        rows.push({
          kind: "block",
          key: `${group.turnId}:${block.kind}:${block.id}`,
          block,
          nested,
        });
      if (group.user) add(group.user);
      // A paginated running turn may not have its user message loaded yet.
      // Group completed tool runs in place; narration and unfinished work stay visible.
      if (!group.end) {
        let tools: Block[] = [];
        const flush = () => {
          if (tools.length < 2) tools.forEach((block) => add(block));
          else {
            const key = `${group.turnId}:tools:${tools[0]!.id}`;
            const open = expandedTurns.has(key);
            rows.push({ kind: "work", key, turnId: key, durationMs: 0,
              label: `${tools.length} completed steps`, expanded: open });
            if (open) tools.forEach((block) => add(block, true));
          }
          tools = [];
        };
        const taskCalls = new Set(group.work.flatMap((block) =>
          block.kind === "runtime_task" && block.task.tool_call_id
            ? [block.task.tool_call_id] : []));
        for (const block of [...group.work, ...group.images].sort((a, b) => a.seq - b.seq)) {
          if (block.kind === "tool" && block.complete && !block.isError &&
              !taskCalls.has(block.call.id) && !launchesAgent(block)) tools.push(block);
          else { flush(); add(block); }
        }
        flush();
      } else {
        const work = group.work.filter((block) => !staysVisible(block));
        group.work.filter(staysVisible).forEach((block) => add(block));
        if (work.length) {
          rows.push({
            kind: "work",
            key: `${group.turnId}:work`,
            turnId: group.turnId,
            durationMs: group.end.durationMs,
            expanded,
          });
          if (expanded) work.forEach((block) => add(block, true));
        }
        group.images.forEach((block) => add(block));
        if (group.answer) add(group.answer);
        add(group.end);
      }
      if (group.reverted) add(group.reverted);
      next.set(group.turnId, { group, expanded, rows });
      result.push(...rows);
    }
    cache = next;
    return result;
  };
}
