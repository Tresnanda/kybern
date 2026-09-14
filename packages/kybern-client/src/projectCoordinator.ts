import type { AgentRpc } from "./agentStart.ts";
import type {
  PermissionMode,
  ProjectCoordinator,
  ProjectCoordinatorCreateParams,
  ProviderStatus,
  UserMessage,
} from "./types.ts";
import { promptText } from "./prompts.ts";

export interface StartProjectCoordinatorInput {
  projectId: string;
  provider: ProviderStatus;
  instance?: string;
  model?: string;
  effort?: string;
  permissionMode?: PermissionMode;
  initialGoal?: string;
}

export function projectCoordinatorMode(kind: ProviderStatus["kind"]): "ordinary" | "dedicated" {
  return ["claude-code", "opencode", "pi", "omp"].includes(kind) ? "dedicated" : "ordinary";
}

/** Every installed harness can coordinate. Only some enforce a dedicated,
 * coordination-only tool surface; callers must describe that distinction. */
export function supportsProjectCoordinator(provider: Pick<ProviderStatus, "kind" | "available">): boolean {
  return provider.available;
}

/** Use one controller for a mounted project entry. A lost acknowledgement
 * retries the frozen creation request; opening a coordinator never starts a turn.
 */
export function createProjectCoordinatorStarter(call: AgentRpc, newId: () => string) {
  let attempt: { fingerprint: string; request: ProjectCoordinatorCreateParams } | undefined;
  let inFlight: { fingerprint: string; promise: Promise<ProjectCoordinator> } | undefined;
  let deliveryAttempt: {
    fingerprint: string;
    messageId: string;
    message: UserMessage;
  } | undefined;
  let deliveryInFlight: { fingerprint: string; promise: Promise<ProjectCoordinator> } | undefined;

  const controller = {
    async start(input: StartProjectCoordinatorInput): Promise<ProjectCoordinator> {
      const model = input.model?.trim() || undefined;
      const effort = input.effort?.trim() || undefined;
      const instance = input.instance?.trim() || (input.provider.instances.includes("default") ? "default" : input.provider.instances[0] || "default");
      const initialGoal = input.initialGoal?.trim() || undefined;
      const coordinatorMode = projectCoordinatorMode(input.provider.kind);
      const fingerprint = JSON.stringify([input.projectId, input.provider.kind, instance, model, effort, input.permissionMode, initialGoal]);
      if (inFlight) {
        if (inFlight.fingerprint !== fingerprint) throw new Error("Wait for the coordinator to finish opening.");
        return inFlight.promise;
      }
      const execute = async (): Promise<ProjectCoordinator> => {
        if (attempt?.fingerprint !== fingerprint) {
          const existing = await call("collaboration.coordinator.get", { project_id: input.projectId });
          if (existing) return existing;
          if (!supportsProjectCoordinator(input.provider)) {
            throw new Error("Choose an available harness for the project coordinator.");
          }
          const modelInfo = input.provider.models?.find((item) => item.id === model);
          if (effort && modelInfo?.efforts?.length && !modelInfo.efforts.includes(effort)) {
            throw new Error("Choose an available effort for the coordinator.");
          }
          const modes = input.provider.supported_permission_modes;
          const permission = input.permissionMode ?? (modes.includes("supervised") ? "supervised" : modes[0]);
          if (!permission || !modes.includes(permission)) {
            throw new Error("Choose a permission mode supported by this provider.");
          }
          attempt = {
            fingerprint,
            request: {
              operation_id: newId(), project_id: input.projectId,
              provider: {
                kind: input.provider.kind,
                instance,
              },
              ...(model ? { model } : {}), ...(effort ? { effort } : {}),
              ...(initialGoal ? { initial_goal: initialGoal } : {}),
              permission_mode: permission, coordinator_mode: coordinatorMode,
            },
          };
        }
        const result = await call("collaboration.coordinator.get_or_create", attempt.request);
        attempt = undefined;
        return result;
      };
      const promise = execute();
      inFlight = { fingerprint, promise };
      try { return await promise; }
      finally { inFlight = undefined; }
    },
    async send(input: StartProjectCoordinatorInput, message: UserMessage): Promise<ProjectCoordinator> {
      const goal = promptText(message).trim();
      if (!goal) throw new Error("Describe what you want the coordinator to accomplish.");
      const fingerprint = JSON.stringify([input.projectId, input.provider.kind, input.instance?.trim(), input.model?.trim(), input.effort?.trim(), input.permissionMode, message]);
      if (deliveryInFlight) {
        if (deliveryInFlight.fingerprint !== fingerprint) throw new Error("Wait for the coordinator's first message to finish sending.");
        return deliveryInFlight.promise;
      }
      if (deliveryAttempt?.fingerprint !== fingerprint) {
        deliveryAttempt = { fingerprint, messageId: newId(), message: structuredClone(message) };
      }
      const frozen = deliveryAttempt;
      const deliver = async () => {
        const result = await controller.start({ ...input, initialGoal: goal });
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
