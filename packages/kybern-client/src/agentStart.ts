import type {
  AssignmentKind,
  CollaborationAssignment,
  CollaborationGroup,
  GitStatus,
  Methods,
  ProviderStatus,
  Thread,
} from "./types.ts";

export type AgentRpc = <M extends keyof Methods>(
  method: M,
  params: Methods[M][0],
) => Promise<Methods[M][1]>;

export interface StartAgentInput {
  thread: Thread;
  group?: CollaborationGroup | null;
  provider: ProviderStatus;
  task: string;
  model?: string;
  title?: string;
  kind?: AssignmentKind;
  baseRevision?: string;
}

export interface StartedAgent {
  group: CollaborationGroup;
  assignment: CollaborationAssignment;
}

export function agentTaskTitle(task: string): string {
  const firstLine = task.trim().split(/\r?\n/)[0].replace(/\s+/g, " ");
  const characters = Array.from(firstLine);
  return characters.length > 80 ? `${characters.slice(0, 79).join("")}…` : firstLine;
}

/** The daemon resolves this shared branch ref to an immutable commit at acceptance.
 * HEAD would resolve in the project checkout, not necessarily the source thread.
 */
export function agentBaseRevision(status: GitStatus, override?: string): string {
  if (!status.is_git) throw new Error("Start agents from a Git project so each agent can have a separate workspace.");
  if (override?.trim()) return override.trim();
  if (!status.branch) throw new Error("This thread is on a detached commit. Choose a branch or commit in Advanced to start the agent.");
  return `refs/heads/${status.branch}`;
}

/** One starter per source thread. Failed submissions keep their exact operation
 * IDs and request payloads, including a group created before a later failure.
 * A successful submission ends the attempt; another deliberate start is new work.
 */
export function createAgentStarter(call: AgentRpc, newId: () => string) {
  let sourceId: string | undefined;
  let group: CollaborationGroup | undefined;
  let completedSourceId: string | undefined;
  let groupRequest: Methods["collaboration.groups.create"][0] | undefined;
  let attempt: {
    fingerprint: string;
    request: Methods["collaboration.assignments.create"][0];
  } | undefined;
  let inFlight: Promise<StartedAgent> | undefined;
  let flightFingerprint: string | undefined;
  let enabling: Promise<CollaborationGroup> | undefined;

  function selectSource(thread: Thread, existing?: CollaborationGroup | null) {
    if (inFlight && existing && existing.id !== group?.id && !(existing.status === "completed" && completedSourceId === existing.id)) {
      throw new Error("Wait for the current agent to finish starting before switching agent history.");
    }
    if (thread.status === "archived") throw new Error("Open an active thread before starting an agent.");
    if (sourceId !== thread.id) {
      if (inFlight || enabling) throw new Error("Wait for the current agent to finish starting before switching threads.");
      sourceId = thread.id;
      completedSourceId = undefined;
      group = undefined;
      groupRequest = undefined;
      attempt = undefined;
    }
    if (existing && existing.status !== "completed") {
      if (existing.project_id !== thread.project_id) throw new Error("Choose an agent group from this project.");
      if (group && group.id !== existing.id) attempt = undefined;
      group = existing;
      completedSourceId = undefined;
    } else if (existing?.status === "completed" && completedSourceId !== existing.id) {
      completedSourceId = existing.id;
      group = undefined;
      groupRequest = undefined;
      attempt = undefined;
    }
    if (group?.status === "paused" || group?.status === "stopped") {
      throw new Error("Resume agents before starting another agent.");
    }
  }

  async function ensureGroup(thread: Thread): Promise<CollaborationGroup> {
    if (group) return group;
    if (enabling) return enabling;
    groupRequest ??= {
      operation_id: newId(),
      project_id: thread.project_id,
      coordinator_thread_id: thread.id,
      objective: thread.title?.trim() || "Help with the work in this thread.",
      success_criteria: [],
      coordinator_mode: "ordinary",
    };
    enabling = call("collaboration.groups.create", groupRequest).then((created) => {
      group = created;
      return created;
    });
    try { return await enabling; }
    finally { enabling = undefined; }
  }

  return {
    get group() { return group; },

    async enable(thread: Thread, existing?: CollaborationGroup | null) {
      selectSource(thread, existing);
      return ensureGroup(thread);
    },

    async start(input: StartAgentInput): Promise<StartedAgent> {
      const task = input.task.trim();
      if (!task) throw new Error("Describe what you want the agent to do.");
      if (!input.provider.available) throw new Error("Choose an available provider to start the agent.");
      if (input.model && !input.provider.models?.some((model) => model.id === input.model)) {
        throw new Error("Choose a model that is available for this provider.");
      }
      selectSource(input.thread, input.group);
      const fingerprint = JSON.stringify([
        input.thread.id, input.provider.kind,
        task, input.model || "", input.title?.trim() || "", input.kind || "edit",
        input.baseRevision?.trim() || "",
      ]);
      if (inFlight) {
        if (flightFingerprint !== fingerprint) throw new Error("Wait for the current agent to finish starting.");
        return inFlight;
      }
      const execute = async (): Promise<StartedAgent> => {
        if (attempt?.fingerprint !== fingerprint) {
          const status = await call("git.status", { thread_id: input.thread.id });
          const kind = input.kind || "edit";
          const needsIsolatedWorkspace = kind !== "research" && kind !== "review";
          let base: string | undefined;
          if (status.is_git && (input.baseRevision?.trim() || status.branch)) {
            base = agentBaseRevision(status, input.baseRevision);
          } else if (needsIsolatedWorkspace) {
            base = agentBaseRevision(status, input.baseRevision);
          }
          const parent = input.thread;
          const permission = parent.permission_mode === "full-access" || parent.provider.kind === input.provider.kind
            ? parent.permission_mode : "supervised";
          const instance = input.provider.instances.includes("default") ? "default" : input.provider.instances[0] || "default";
          // Validate and freeze the source before creating any group.
          const ready = await ensureGroup(input.thread);
          attempt = {
            fingerprint,
            request: {
              operation_id: newId(), group_id: ready.id,
              title: input.title?.trim() || agentTaskTitle(task), instructions: task,
              kind,
              child: {
                provider: { kind: input.provider.kind, instance },
                ...(input.model ? { model: input.model } : {}),
                permission_mode: permission,
                ...(base ? { base_revision: base } : {}),
              },
            },
          };
        }
        const assignment = await call("collaboration.assignments.create", attempt!.request);
        const result = { group: group!, assignment };
        attempt = undefined;
        return result;
      };
      flightFingerprint = fingerprint;
      inFlight = execute();
      try { return await inFlight; }
      finally { inFlight = undefined; flightFingerprint = undefined; }
    },
  };
}
