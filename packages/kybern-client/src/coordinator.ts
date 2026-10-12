import type {
  CoordinatorOpenResult,
  Methods,
  PermissionMode,
  ProviderStatus,
  Thread,
  UserMessage,
} from "./types.ts";
import { promptText } from "./prompts.ts";

export type CoordinatorRpc = <M extends keyof Methods>(
  method: M,
  params: Methods[M][0],
) => Promise<Methods[M][1]>;

/** A project's Coordinator is its lead thread: the thread that carries `coordinator_project_id`. */
export function isCoordinatorThread(thread: Pick<Thread, "coordinator_project_id"> | null | undefined): boolean {
  return !!thread?.coordinator_project_id;
}

/** Whether the daemon can block file edits for a Coordinator on this harness. It mirrors
 * `lead_restrictions_enforced` in the Rust daemon: Codex and Cursor cannot select tools, so
 * their Coordinator follows its instructions only and clients must say so. */
export function coordinatorEditsEnforced(kind: ProviderStatus["kind"]): boolean {
  return kind === "claude-code" || kind === "opencode" || kind === "pi" || kind === "omp";
}

/** Shown beside a Coordinator on a harness that cannot block edits. */
export const COORDINATOR_EDITS_NOT_BLOCKED_HINT =
  "Codex and Cursor can't block file edits, so the Coordinator follows its instructions only.";

/** Every installed harness can host a Coordinator. */
export function supportsProjectCoordinator(provider: Pick<ProviderStatus, "kind" | "available">): boolean {
  return provider.available;
}

export interface StartProjectCoordinatorInput {
  projectId: string;
  provider: ProviderStatus;
  instance?: string;
  model?: string;
  effort?: string;
  permissionMode?: PermissionMode;
  /** The user's first message; becomes the project's brief when the project has none. */
  initialBrief?: string;
}

/** Use one controller for a mounted project entry. `coordinator.open` is idempotent on the
 * daemon, so a lost acknowledgement just retries; the first message keeps one client id.
 * Opening a Coordinator never starts a turn. */
export function createCoordinatorStarter(call: CoordinatorRpc, newId: () => string) {
  let inFlight: { fingerprint: string; promise: Promise<CoordinatorOpenResult> } | undefined;
  let deliveryAttempt: { fingerprint: string; messageId: string; message: UserMessage } | undefined;
  let deliveryInFlight: { fingerprint: string; promise: Promise<CoordinatorOpenResult> } | undefined;

  const controller = {
    async start(input: StartProjectCoordinatorInput): Promise<CoordinatorOpenResult> {
      const model = input.model?.trim() || undefined;
      const effort = input.effort?.trim() || undefined;
      const instance = input.instance?.trim() || (input.provider.instances.includes("default") ? "default" : input.provider.instances[0] || "default");
      const initialBrief = input.initialBrief?.trim() || undefined;
      const fingerprint = JSON.stringify([input.projectId, input.provider.kind, instance, model, effort, input.permissionMode, initialBrief]);
      if (inFlight) {
        if (inFlight.fingerprint !== fingerprint) throw new Error("Wait for the Coordinator to finish opening.");
        return inFlight.promise;
      }
      const execute = async (): Promise<CoordinatorOpenResult> => {
        const existing = await call("coordinator.get", { project_id: input.projectId });
        if (existing) return { thread: existing, created: false };
        if (!supportsProjectCoordinator(input.provider)) {
          throw new Error("Choose an available harness for the Coordinator.");
        }
        const modelInfo = input.provider.models?.find((item) => item.id === model);
        if (effort && modelInfo?.efforts?.length && !modelInfo.efforts.includes(effort)) {
          throw new Error("Choose an available effort for the Coordinator.");
        }
        const modes = input.provider.supported_permission_modes;
        const permission = input.permissionMode ?? (modes.includes("supervised") ? "supervised" : modes[0]);
        if (!permission || !modes.includes(permission)) {
          throw new Error("Choose a permission mode supported by this provider.");
        }
        return call("coordinator.open", {
          project_id: input.projectId,
          provider: { kind: input.provider.kind, instance },
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
          permission_mode: permission,
          ...(initialBrief ? { initial_brief: initialBrief } : {}),
        });
      };
      const promise = execute();
      inFlight = { fingerprint, promise };
      try { return await promise; }
      finally { inFlight = undefined; }
    },
    /** Open the Coordinator with the message as its brief, then send the message as its first turn. */
    async send(input: StartProjectCoordinatorInput, message: UserMessage): Promise<CoordinatorOpenResult> {
      const goal = promptText(message).trim();
      if (!goal) throw new Error("Describe what you want the Coordinator to work on.");
      const fingerprint = JSON.stringify([input.projectId, input.provider.kind, input.instance?.trim(), input.model?.trim(), input.effort?.trim(), input.permissionMode, message]);
      if (deliveryInFlight) {
        if (deliveryInFlight.fingerprint !== fingerprint) throw new Error("Wait for the Coordinator's first message to finish sending.");
        return deliveryInFlight.promise;
      }
      if (deliveryAttempt?.fingerprint !== fingerprint) {
        deliveryAttempt = { fingerprint, messageId: newId(), message: structuredClone(message) };
      }
      const frozen = deliveryAttempt;
      const deliver = async () => {
        const result = await controller.start({ ...input, initialBrief: goal });
        await call("threads.send", {
          thread_id: result.thread.id,
          message_id: frozen.messageId,
          message: frozen.message,
        });
        deliveryAttempt = undefined;
        return result;
      };
      const promise = deliver();
      deliveryInFlight = { fingerprint, promise };
      try { return await promise; }
      finally { deliveryInFlight = undefined; }
    },
  };
  return controller;
}
