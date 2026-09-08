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
      expanded: boolean;
    };

export function workDuration(milliseconds: number) {
  const seconds = Math.max(1, Math.round(milliseconds / 1000));
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
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
      if (previous?.group === group && previous.expanded === expanded) {
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
      // Only its completion record can make it eligible for folding.
      if (!group.end) {
        [...group.work, ...group.images]
          .sort((a, b) => a.seq - b.seq)
          .forEach((block) => add(block));
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
