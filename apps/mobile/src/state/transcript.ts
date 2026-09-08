import * as shared from "../../../../packages/kybern-client/src/transcript.ts";
import type {
  RuntimeTask,
  ThreadEvent,
  ThreadsGetResult,
  TranscriptEntry,
} from "./protocol";
export type { Block } from "../../../../packages/kybern-client/src/transcript.ts";
export type ThreadState = shared.ThreadState & {
  tasks: RuntimeTask[];
  taskActivity: Record<string, shared.Block[]>;
  nextBeforeSeq: number | null;
  loadingEarlier: boolean;
};
export const emptyThreadState = (): ThreadState => ({
  ...shared.emptyThreadState(),
  tasks: [],
  taskActivity: {},
  nextBeforeSeq: null,
  loadingEarlier: false,
});
function agentId(entry: TranscriptEntry) {
  return "origin" in entry && entry.origin?.kind === "agent"
    ? entry.origin.task_id
    : null;
}
export function seedFromGet(result: ThreadsGetResult): ThreadState {
  const root = shared.seedFromGet({
    ...result,
    transcript: result.transcript.filter((e) => !agentId(e)),
  });
  const taskActivity: Record<string, shared.Block[]> = {};
  for (const id of new Set(
    result.transcript.map(agentId).filter((id): id is string => !!id),
  )) {
    taskActivity[id] = shared.seedFromGet({
      ...result,
      transcript: result.transcript
        .filter((e) => agentId(e) === id)
        .map((e) => ({ ...e, origin: { kind: "root" as const } })),
    }).blocks;
  }
  const tasks = new Map(
    root.blocks.flatMap((b) =>
      b.kind === "runtime_task" ? [[b.task.id, b.task] as const] : [],
    ),
  );
  for (const task of result.runtime_tasks ?? []) tasks.set(task.id, task);
  const blocks = root.blocks.map((b) =>
    b.kind === "runtime_task" ? { ...b, task: tasks.get(b.task.id)! } : b,
  );
  for (const task of tasks.values())
    if (!blocks.some((b) => b.kind === "runtime_task" && b.task.id === task.id))
      blocks.push({
        kind: "runtime_task",
        id: `task:${task.id}`,
        turnId: task.origin_turn_id,
        at: task.started_at,
        seq: task.started_seq,
        task,
      });
  blocks.sort((a, b) => a.seq - b.seq);
  return {
    ...root,
    blocks,
    tasks: [...tasks.values()],
    taskActivity,
    nextBeforeSeq: result.next_before_seq ?? null,
    loadingEarlier: false,
  };
}

const blockKey = (block: shared.Block) => `${block.kind}:${block.id}`;
function mergeBlocks(current: shared.Block[], older: shared.Block[]) {
  const byId = new Map(current.map((block) => [blockKey(block), block]));
  for (const block of older) {
    const existing = byId.get(blockKey(block));
    // A live delta can create a partial row whose beginning is in an unloaded
    // page. Prefer the authoritative earlier beginning when that page arrives.
    if (!existing || existing.seq > block.seq) byId.set(blockKey(block), block);
  }
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

/** Merge at the request's sequence barrier, then replay events received in flight. */
export function prependHistory(
  base: ThreadState,
  page: ThreadsGetResult,
  events: ThreadEvent[] = [],
): ThreadState {
  const older = seedFromGet(page);
  const activity = { ...base.taskActivity };
  for (const [id, blocks] of Object.entries(older.taskActivity))
    activity[id] = mergeBlocks(activity[id] ?? [], blocks);
  let next = {
    ...base,
    blocks: mergeBlocks(base.blocks, older.blocks),
    taskActivity: activity,
    nextBeforeSeq: older.nextBeforeSeq,
    loadingEarlier: false,
  };
  for (const event of events) next = applyEvent(next, event);
  return next;
}

/** A page replay must not invalidate rows the visible stream already settled. */
export function retainHistoryIdentities(
  next: ThreadState,
  visible: ThreadState,
): ThreadState {
  const retain = (blocks: shared.Block[], previous: shared.Block[]) => {
    const byId = new Map(previous.map((block) => [blockKey(block), block]));
    return blocks.map((block) => {
      const old = byId.get(blockKey(block));
      return old &&
        (old === block || JSON.stringify(old) === JSON.stringify(block))
        ? old
        : block;
    });
  };
  const taskActivity = { ...next.taskActivity };
  for (const [id, blocks] of Object.entries(taskActivity))
    taskActivity[id] = retain(blocks, visible.taskActivity[id] ?? []);
  return { ...next, blocks: retain(next.blocks, visible.blocks), taskActivity };
}
export function applyEvent(
  state: ThreadState,
  event: ThreadEvent,
): ThreadState {
  if (event.seq <= state.lastSeq) return state;
  const originTask =
    "origin" in event && event.origin?.kind === "agent"
      ? event.origin.task_id
      : null;
  // Tool output events carry only the call ID; retain their owning agent.
  const toolTask =
    event.kind === "tool_call_output_delta" ||
    event.kind === "tool_call_completed"
      ? Object.keys(state.taskActivity).find((id) =>
          state.taskActivity[id]?.some(
            (b) => b.kind === "tool" && b.call.id === event.tool_call_id,
          ),
        )
      : undefined;
  const id = originTask ?? toolTask;
  if (id) {
    const childEvent =
      "origin" in event
        ? { ...event, origin: { kind: "root" as const } }
        : event;
    const child = shared.applyEvent(
      { ...shared.emptyThreadState(), blocks: state.taskActivity[id] ?? [] },
      childEvent,
    );
    return {
      ...state,
      lastSeq: event.seq,
      taskActivity: { ...state.taskActivity, [id]: child.blocks },
    };
  }
  const next = shared.applyEvent(state, event);
  let tasks = state.tasks;
  if (
    event.kind === "runtime_task_started" ||
    event.kind === "runtime_task_updated" ||
    event.kind === "runtime_task_completed"
  ) {
    const task = next.blocks.find(
      (b) => b.kind === "runtime_task" && b.task.id === event.task.id,
    );
    if (task?.kind === "runtime_task")
      tasks = [...tasks.filter((t) => t.id !== task.task.id), task.task];
  }
  return {
    ...next,
    tasks,
    taskActivity: state.taskActivity,
    nextBeforeSeq: state.nextBeforeSeq,
    loadingEarlier: state.loadingEarlier,
  };
}
