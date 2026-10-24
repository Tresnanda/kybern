import type {
  CoordinatorOpenParams,
  CoordinatorOpenResult,
  Methods,
  PermissionMode,
  ProviderStatus,
  Thread,
  UserMessage,
} from "./types.ts";
import { partToken } from "./composerTokens.ts";

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

/** The Draft's line under the Coordinator heading. */
export const COORDINATOR_DRAFT_HINT = "Tell the Coordinator about this project. It asks a few questions to set itself up.";

export interface StartProjectCoordinatorInput {
  projectId: string;
  provider: ProviderStatus;
  instance?: string;
  model?: string;
  effort?: string;
  permissionMode?: PermissionMode;
  /**
   * The user's opening words. A Coordinator created for a project without a brief starts
   * its setup interview with them as the user's first answer; with a brief the daemon sends
   * them as an ordinary first message. They never become the brief.
   */
  openingMessage?: string;
}

/**
 * The opening message as one string, for `coordinator.open`: text as typed, with skills,
 * files, mentions and thread references written where they stood.
 */
export function openingMessageText(message: UserMessage): string {
  return message.parts
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "thread_reference") return part.title;
      return partToken(part) ?? "";
    })
    .join("")
    .trim();
}

/**
 * `coordinator.open`'s parameters for this input, after the checks the daemon would otherwise
 * refuse: an available harness, an effort the model offers, a supported permission mode.
 */
export function coordinatorOpenParams(input: StartProjectCoordinatorInput): CoordinatorOpenParams {
  const model = input.model?.trim() || undefined;
  const effort = input.effort?.trim() || undefined;
  const instance = input.instance?.trim() || (input.provider.instances.includes("default") ? "default" : input.provider.instances[0] || "default");
  const openingMessage = input.openingMessage?.trim() || undefined;
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
  return {
    project_id: input.projectId,
    provider: { kind: input.provider.kind, instance },
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    permission_mode: permission,
    ...(openingMessage ? { opening_message: openingMessage } : {}),
  };
}

/** Use one controller for a mounted project entry. `coordinator.open` is idempotent on the
 * daemon, so a lost acknowledgement just retries; a first message for an existing
 * Coordinator keeps one client id. */
export function createCoordinatorStarter(call: CoordinatorRpc, newId: () => string) {
  let inFlight: { fingerprint: string; promise: Promise<CoordinatorOpenResult> } | undefined;
  let deliveryAttempt: { fingerprint: string; messageId: string; message: UserMessage; openSent: boolean } | undefined;
  let deliveryInFlight: { fingerprint: string; promise: Promise<CoordinatorOpenResult> } | undefined;

  const controller = {
    async start(input: StartProjectCoordinatorInput, onOpenSent?: () => void): Promise<CoordinatorOpenResult> {
      const model = input.model?.trim() || undefined;
      const effort = input.effort?.trim() || undefined;
      const instance = input.instance?.trim() || (input.provider.instances.includes("default") ? "default" : input.provider.instances[0] || "default");
      const openingMessage = input.openingMessage?.trim() || undefined;
      const fingerprint = JSON.stringify([input.projectId, input.provider.kind, instance, model, effort, input.permissionMode, openingMessage]);
      if (inFlight) {
        if (inFlight.fingerprint !== fingerprint) throw new Error("Wait for the Coordinator to finish opening.");
        return inFlight.promise;
      }
      const execute = async (): Promise<CoordinatorOpenResult> => {
        const existing = await call("coordinator.get", { project_id: input.projectId });
        if (existing) return { thread: existing, created: false };
        const params = coordinatorOpenParams(input);
        onOpenSent?.();
        return call("coordinator.open", params);
      };
      const promise = execute();
      inFlight = { fingerprint, promise };
      try { return await promise; }
      finally { inFlight = undefined; }
    },
    /**
     * Open the Coordinator with the message as its opening words. A Coordinator the daemon
     * creates here starts its first turn with them (the setup interview, or an ordinary
     * message when the project has a brief), so nothing else is sent. A Coordinator that
     * already existed gets the message as a normal send, with one frozen client id.
     */
    async send(input: StartProjectCoordinatorInput, message: UserMessage): Promise<CoordinatorOpenResult> {
      const opening = openingMessageText(message);
      if (!opening) throw new Error("Tell the Coordinator about the project first.");
      const fingerprint = JSON.stringify([input.projectId, input.provider.kind, input.instance?.trim(), input.model?.trim(), input.effort?.trim(), input.permissionMode, message]);
      if (deliveryInFlight) {
        if (deliveryInFlight.fingerprint !== fingerprint) throw new Error("Wait for the Coordinator's first message to finish sending.");
        return deliveryInFlight.promise;
      }
      if (deliveryAttempt?.fingerprint !== fingerprint) {
        deliveryAttempt = { fingerprint, messageId: newId(), message: structuredClone(message), openSent: false };
      }
      const frozen = deliveryAttempt;
      const deliver = async () => {
        const result = await controller.start({ ...input, openingMessage: opening }, () => { frozen.openSent = true; });
        // A retry after a lost acknowledgement finds the Coordinator this delivery created,
        // which already has the message; only one that was there before needs it sent.
        if (!result.created && !frozen.openSent) {
          await call("threads.send", { thread_id: result.thread.id, message_id: frozen.messageId, message: frozen.message });
        }
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

