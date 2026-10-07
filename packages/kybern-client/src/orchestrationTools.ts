// How the transcript reads Kybern's orchestration tools (`kybern_agent_*`, `kybern_thread_send`,
// `kybern_thread_interrupt`). Every harness spells a tool its own way (`mcp__kybern__kybern_agent_delegate`
// for Claude, the bare name for pi) and wraps the daemon's JSON object in its own envelope; this module
// recognises both. Pure, so the mobile client can reuse it.

import { plainLine } from "./delegations.ts";
import type { DelegationRole, DelegationStatus, DelegationWorkspace, JsonValue, ThreadMessagePurpose } from "./types.ts";

export type OrchestrationToolName =
  | "agent_delegate"
  | "agent_status"
  | "agent_wait"
  | "agent_cancel"
  | "agent_capabilities"
  | "thread_interrupt"
  | "thread_send";

const TOOL_PATTERN = /(?:^|[^a-z0-9])kybern_(agent_delegate|agent_status|agent_wait|agent_cancel|agent_capabilities|thread_interrupt|thread_send)$/;

/** The orchestration tool a call ran, under any harness's namespacing. */
export function orchestrationTool(name: string): OrchestrationToolName | null {
  const match = TOOL_PATTERN.exec(name.toLowerCase());
  return match ? (match[1] as OrchestrationToolName) : null;
}

/** A call that starts a delegated child; two or more in a turn fold into one group row. */
export function isDelegateTool(name: string): boolean {
  return orchestrationTool(name) === "agent_delegate";
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const optional = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

/**
 * The first object in a tool result that `read` accepts, looking through an MCP `content` array,
 * a nested `result`, or the bare JSON text.
 */
export function findToolJson<T>(output: JsonValue | null | undefined, read: (value: Record<string, unknown>) => T | null): T | null {
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number): T | null => {
    if (depth > 6 || value === null || value === undefined || seen.has(value)) return null;
    if (typeof value === "string") {
      const text = value.trim();
      if (!text.startsWith("{") || text.length > 512 * 1024) return null;
      try {
        return visit(JSON.parse(text), depth + 1);
      } catch {
        return null;
      }
    }
    if (typeof value !== "object") return null;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = visit(item, depth + 1);
        if (found) return found;
      }
      return null;
    }
    const object = value as Record<string, unknown>;
    const direct = read(object);
    if (direct) return direct;
    for (const key of ["structuredContent", "structured", "result", "content", "output", "text"] as const) {
      const found = visit(object[key], depth + 1);
      if (found) return found;
    }
    return null;
  };
  return visit(output, 0);
}

// ---- kybern_agent_delegate ----

export interface DelegateInput {
  task: string;
  title: string | null;
  role: DelegationRole | null;
  provider: string | null;
  model: string | null;
  workspace: DelegationWorkspace;
  /** The idempotency key the agent passed, when it passed one. */
  operationId: string | null;
}

export function parseDelegateInput(input: JsonValue): DelegateInput {
  const value = record(input) ?? {};
  const role = str(value.role);
  return {
    task: str(value.task),
    title: optional(value.title),
    role: ["implementation", "research", "review", "design", "test", "general"].includes(role) ? (role as DelegationRole) : null,
    provider: optional(value.provider),
    model: optional(value.model),
    workspace: value.workspace === "worktree" ? "worktree" : "shared",
    operationId: optional(value.operation_id) ?? optional(value.request_key),
  };
}

export interface DelegateResult {
  taskId: string;
  threadId: string;
  title: string;
  provider: string | null;
  model: string | null;
  workspace: DelegationWorkspace;
  branch: string | null;
  status: DelegationStatus | null;
  result: string | null;
  error: string | null;
  waitTimedOut: boolean;
}

const STATUSES: readonly string[] = ["running", "completed", "failed", "cancelled", "interrupted"];

export function parseDelegateResult(output: JsonValue | null | undefined): DelegateResult | null {
  return findToolJson(output, (value) => {
    const taskId = str(value.task_id);
    const threadId = str(value.thread_id);
    if (!taskId || !threadId) return null;
    const status = str(value.status);
    return {
      taskId,
      threadId,
      title: str(value.title),
      provider: optional(value.provider),
      model: optional(value.model),
      workspace: value.workspace === "worktree" ? "worktree" : "shared",
      branch: optional(value.branch),
      status: STATUSES.includes(status) ? (status as DelegationStatus) : null,
      result: optional(value.result),
      error: optional(value.error),
      waitTimedOut: value.wait_timed_out === true,
    };
  });
}

/** Title of a launch before its child thread is known: the call's title, else the first line of its brief. */
export function delegateTitle(input: JsonValue, result: DelegateResult | null): string {
  const parsed = parseDelegateInput(input);
  return result?.title || parsed.title || plainLine(parsed.task, 60) || "Delegated agent";
}

// ---- kybern_thread_send ----

export type SendState = "queued" | "steered" | "held" | "delivered" | "answered" | "failed";

export interface SendInput {
  threadId: string;
  body: string;
  purpose: ThreadMessagePurpose;
  replyTo: string | null;
  steer: boolean;
  waitForReply: boolean;
}

export function parseSendInput(input: JsonValue): SendInput {
  const value = record(input) ?? {};
  const purpose = str(value.purpose);
  return {
    threadId: str(value.thread_id),
    body: str(value.body),
    purpose: purpose === "question" || purpose === "reply" ? purpose : "message",
    replyTo: optional(value.reply_to),
    steer: value.delivery === "steer",
    waitForReply: value.wait_for_reply === true,
  };
}

export interface SendResult {
  messageId: string;
  state: SendState;
  reply: { messageId: string; fromThreadId: string; body: string } | null;
  waitTimedOut: boolean;
}

export function parseSendResult(output: JsonValue | null | undefined): SendResult | null {
  return findToolJson(output, (value) => {
    const messageId = str(value.message_id);
    if (!messageId || (value.state === undefined && value.delivered_as === undefined)) return null;
    const raw = str(value.delivered_as) || str(value.state);
    const state: SendState = raw === "held" ? "held" : raw === "steered" ? "steered" : raw === "answered" ? "answered" : raw === "delivered" ? "delivered" : raw === "failed" ? "failed" : "queued";
    const reply = record(value.reply);
    return {
      messageId,
      state,
      reply: reply && str(reply.body) ? { messageId: str(reply.message_id), fromThreadId: str(reply.from_thread_id), body: str(reply.body) } : null,
      waitTimedOut: value.wait_timed_out === true,
    };
  });
}

/** The word a "Sent to" row shows. A reply that came back makes it `Answered`. */
export function sendStateWord(result: SendResult | null, complete: boolean, isError: boolean): string {
  if (isError) return "Not sent";
  if (!complete) return "Sending";
  if (!result) return "Sent";
  if (result.reply) return "Answered";
  switch (result.state) {
    case "held":
      return "Held for approval";
    case "steered":
      return "Sent now";
    case "queued":
      return "Queued";
    case "answered":
      return "Answered";
    case "delivered":
      return "Delivered";
    case "failed":
      return "Not delivered";
  }
}

// ---- one-line labels ----

const quoted = (title: string) => {
  const clean = title.replace(/\s+/g, " ").trim();
  return clean ? `“${clean.length > 48 ? `${clean.slice(0, 47).trimEnd()}…` : clean}”` : "";
};

/**
 * Tense-aware label of the quieter orchestration tools. `kybern_agent_delegate` and
 * `kybern_thread_send` have their own rows; these get one line each.
 */
export function orchestrationLabel(tool: OrchestrationToolName, complete: boolean, isError: boolean): string {
  if (isError) {
    switch (tool) {
      case "agent_delegate":
        return "Unable to delegate";
      case "agent_status":
        return "Unable to check delegated agents";
      case "agent_wait":
        return "Unable to wait for delegated agents";
      case "agent_cancel":
        return "Unable to stop a delegated agent";
      case "agent_capabilities":
        return "Unable to list agents";
      case "thread_interrupt":
        return "Unable to stop a thread";
      case "thread_send":
        return "Unable to send a message";
    }
  }
  switch (tool) {
    case "agent_delegate":
      return complete ? "Delegated an agent" : "Delegating an agent";
    case "agent_status":
      return complete ? "Checked delegated agents" : "Checking delegated agents";
    case "agent_wait":
      return complete ? "Waited for delegated agents" : "Waiting for delegated agents";
    case "agent_cancel":
      return complete ? "Stopped a delegated agent" : "Stopping a delegated agent";
    case "agent_capabilities":
      return complete ? "Listed available agents" : "Listing available agents";
    case "thread_interrupt":
      return complete ? "Stopped a thread" : "Stopping a thread";
    case "thread_send":
      return complete ? "Sent a message" : "Sending a message";
  }
}

/** Quoted title for labels that name a target. */
export function quotedTitle(title: string): string {
  return quoted(title);
}
