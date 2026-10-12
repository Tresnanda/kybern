// `kybern_request_secret` cards, as both clients show them: reading the card's input,
// the line that says where the value goes, and the one quiet line a settled request
// leaves in the transcript. The value itself never passes through here.
import { SECRET_REQUEST_TOOL, type ApprovalDecision, type ApprovalRequest, type SecretRequestInput } from "./types.ts";

/** Why the daemon closes a card nobody answered (see `secret_request.rs`). */
const TURN_ENDED = "turn ended";
const TIMED_OUT = "timed out";

export const SECRET_REQUEST_COPY = {
  footnote: "Kybern writes it to the file. The agent never sees it.",
  save: "Save securely",
  decline: "Decline",
  saving: "Saving…",
  empty: "Paste the value to save it.",
} as const;

/** The card's input when the approval is a secret request; null for any other approval. */
export function secretRequestInput(approval: Pick<ApprovalRequest, "tool_name" | "input">): SecretRequestInput | null {
  if (approval.tool_name !== SECRET_REQUEST_TOOL) return null;
  const input = approval.input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  const envKey = text(record.env_key);
  if (!envKey) return null;
  return {
    label: text(record.label) || envKey,
    reason: text(record.reason),
    env_key: envKey,
    file: text(record.file) || ".env",
    replaces: record.replaces === true,
    placeholder: text(record.placeholder) || null,
  };
}

export function isSecretRequest(approval: Pick<ApprovalRequest, "tool_name">): boolean {
  return approval.tool_name === SECRET_REQUEST_TOOL;
}

/** A text run with code spans marked, so each client can style the file and key as code. */
export type SecretTextPart = { text: string; code?: boolean };

/** "Saves to `.env` as `KEY`", or "Replaces the current value of `KEY` in `file`". */
export function secretDestination(input: Pick<SecretRequestInput, "env_key" | "file" | "replaces">): SecretTextPart[] {
  return input.replaces
    ? [{ text: "Replaces the current value of " }, { text: input.env_key, code: true }, { text: " in " }, { text: input.file, code: true }]
    : [{ text: "Saves to " }, { text: input.file, code: true }, { text: " as " }, { text: input.env_key, code: true }];
}

export type SecretOutcome = "pending" | "saved" | "declined" | "ended";

/** What became of a request, from the approval's recorded decision. */
export function secretOutcome(decision: ApprovalDecision | null): SecretOutcome {
  if (!decision) return "pending";
  if (decision.decision === "submit") return "saved";
  if (decision.decision === "deny") return decision.reason === TURN_ENDED || decision.reason === TIMED_OUT ? "ended" : "declined";
  return "ended";
}

/**
 * The one line a request leaves in the transcript. `live` is false once the turn is
 * over: a card still unanswered then (a restarted daemon) reads as ended.
 */
export function secretOutcomeLine(input: Pick<SecretRequestInput, "env_key" | "file">, decision: ApprovalDecision | null, live = true): SecretTextPart[] {
  const outcome = secretOutcome(decision);
  switch (outcome === "pending" && !live ? "ended" : outcome) {
    case "pending":
      return [{ text: "Waiting for you to provide " }, { text: input.env_key, code: true }];
    case "saved":
      return [{ text: "Saved to " }, { text: input.file, code: true }, { text: " as " }, { text: input.env_key, code: true }];
    case "declined":
      return [{ text: "Declined " }, { text: input.env_key, code: true }];
    case "ended": {
      const reason = decision?.decision === "deny" ? decision.reason : null;
      return [{ text: reason === TIMED_OUT ? "Request ended: no answer in time" : "Request ended: the agent stopped before you answered" }];
    }
  }
}

/** Plain text for a list of parts, for titles and accessibility labels. */
export function secretPartsText(parts: readonly SecretTextPart[]): string {
  return parts.map((part) => part.text).join("");
}
